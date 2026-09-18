// N-API bridge for the U.are.U SDK (dpfpdd capture + dpfj matching).
// Sync wrappers return values directly; *Async wrappers run on the libuv
// thread pool via Napi::AsyncWorker so the JS event loop is never blocked.
// Image/FMD data crosses as Buffers.

#include <napi.h>

#include <dpfpdd.h>
#include <dpfj.h>

#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

// ---------------- handle registry ----------------

struct HandleEntry {
  DPFPDD_DEV dev = NULL;
  uint32_t dpi = 0;      // first supported resolution, cached at open
  bool busy = false;     // a capture is in flight on this handle
  bool closing = false;  // close() was requested while busy
};

std::mutex g_mtx;
std::map<uint32_t, std::shared_ptr<HandleEntry>> g_handles;
uint32_t g_nextHandle = 1;

std::string Hex(int v) {
  char buf[24];
  snprintf(buf, sizeof(buf), "0x%08x", static_cast<unsigned int>(v));
  return buf;
}

[[noreturn]] void ThrowDp(const Napi::Env& env, const char* what, int code) {
  throw Napi::Error::New(env, std::string(what) + " failed (code " + Hex(code) + ")");
}

void CheckDp(const Napi::Env& env, const char* what, int code) {
  if (code != DPFPDD_SUCCESS && code != DPFJ_SUCCESS) ThrowDp(env, what, code);
}

uint32_t OptU32(const Napi::Env& env, const Napi::Value& v, uint32_t def) {
  if (v.IsUndefined() || v.IsNull()) return def;
  return v.ToNumber().Uint32Value();
}

uint32_t OptObjU32(const Napi::Env& env, const Napi::Object& o, const char* key, uint32_t def) {
  if (!o.Has(key)) return def;
  Napi::Value v = o.Get(key);
  if (v.IsUndefined() || v.IsNull()) return def;
  return v.ToNumber().Uint32Value();
}

uint32_t FirstDpi(DPFPDD_DEV dev) {
  unsigned int size = sizeof(unsigned int);
  int r = dpfpdd_get_device_capabilities(dev, reinterpret_cast<DPFPDD_DEV_CAPS*>(&size));
  if (r != DPFPDD_E_MORE_DATA || size == 0) return 0;
  std::vector<unsigned char> buf(size);
  auto* caps = reinterpret_cast<DPFPDD_DEV_CAPS*>(buf.data());
  caps->size = size;
  if (dpfpdd_get_device_capabilities(dev, caps) != DPFPDD_SUCCESS) return 0;
  return caps->resolution_cnt > 0 ? caps->resolutions[0] : 0;
}

std::shared_ptr<HandleEntry> GetEntry(const Napi::CallbackInfo& info, int idx = 0) {
  uint32_t h = info[idx].ToNumber().Uint32Value();
  std::lock_guard<std::mutex> lock(g_mtx);
  auto it = g_handles.find(h);
  if (it == g_handles.end())
    throw Napi::Error::New(info.Env(), "invalid reader handle");
  return it->second;
}

// ---------------- capture core (runs on worker thread) ----------------

struct CaptureOut {
  int code = DPFPDD_SUCCESS;  // dpfpdd error code
  int success = 0;
  unsigned int quality = 0;
  unsigned int score = 0;
  unsigned int width = 0, height = 0, res = 0, bpp = 0;
  std::vector<unsigned char> img;
};

// Blocking capture with two-pass buffer sizing. Safe to call from a worker
// thread. Returns a dpfpdd code; on DPFPDD_SUCCESS `out` is filled.
int DoCapture(DPFPDD_DEV dev, uint32_t fmt, uint32_t proc, uint32_t dpi,
              uint32_t timeout, CaptureOut* out) {
  DPFPDD_CAPTURE_PARAM cp = {};
  cp.size = sizeof(cp);
  cp.image_fmt = static_cast<DPFPDD_IMAGE_FMT>(fmt);
  cp.image_proc = static_cast<DPFPDD_IMAGE_PROC>(proc);
  cp.image_res = dpi;

  DPFPDD_CAPTURE_RESULT cr = {};
  cr.size = sizeof(cr);
  cr.info.size = sizeof(cr.info);

  unsigned int imgSize = 0;
  int r = dpfpdd_capture(dev, &cp, timeout, &cr, &imgSize, NULL);
  if (r != DPFPDD_E_MORE_DATA && r != DPFPDD_SUCCESS) return r;

  out->img.resize(imgSize);
  r = dpfpdd_capture(dev, &cp, timeout, &cr, &imgSize, imgSize ? out->img.data() : NULL);
  if (r == DPFPDD_E_MORE_DATA) {
    out->img.resize(imgSize);
    r = dpfpdd_capture(dev, &cp, timeout, &cr, &imgSize, out->img.data());
  }
  if (r != DPFPDD_SUCCESS) return r;

  out->success = cr.success;
  out->quality = cr.quality;
  out->score = cr.score;
  out->width = cr.info.width;
  out->height = cr.info.height;
  out->res = cr.info.res;
  out->bpp = cr.info.bpp;
  return DPFPDD_SUCCESS;
}

Napi::Object BuildCaptureResult(Napi::Env env, const CaptureOut& out) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("success", out.success != 0);
  o.Set("quality", out.quality);
  o.Set("score", out.score);
  o.Set("width", out.width);
  o.Set("height", out.height);
  o.Set("dpi", out.res);
  o.Set("bpp", out.bpp);
  if (out.success && !out.img.empty())
    o.Set("image", Napi::Buffer<unsigned char>::Copy(env, out.img.data(), out.img.size()));
  else
    o.Set("image", env.Null());
  return o;
}

// ---------------- module lifecycle ----------------

Napi::Value DpInit(const Napi::CallbackInfo& info) {
  CheckDp(info.Env(), "dpfpdd_init", dpfpdd_init());
  return info.Env().Undefined();
}

Napi::Value DpExit(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g_mtx);
  for (auto& kv : g_handles) dpfpdd_close(kv.second->dev);
  g_handles.clear();
  CheckDp(info.Env(), "dpfpdd_exit", dpfpdd_exit());
  return info.Env().Undefined();
}

Napi::Value DpVersion(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DPFPDD_VERSION v = {};
  v.size = sizeof(v);
  CheckDp(env, "dpfpdd_version", dpfpdd_version(&v));
  DPFJ_VERSION jv = {};
  jv.size = sizeof(jv);
  CheckDp(env, "dpfj_version", dpfj_version(&jv));

  Napi::Object out = Napi::Object::New(env);
  Napi::Object cap = Napi::Object::New(env);
  cap.Set("major", v.lib_ver.major);
  cap.Set("minor", v.lib_ver.minor);
  cap.Set("maintenance", v.lib_ver.maintenance);
  out.Set("capture", cap);
  Napi::Object fj = Napi::Object::New(env);
  fj.Set("major", jv.lib_ver.major);
  fj.Set("minor", jv.lib_ver.minor);
  fj.Set("maintenance", jv.lib_ver.maintenance);
  out.Set("fingerjet", fj);
  return out;
}

Napi::Value SelectEngine(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DPFJ_ENGINE_TYPE engine = static_cast<DPFJ_ENGINE_TYPE>(OptU32(env, info[0], DPFJ_ENGINE_DPFJ));
  CheckDp(env, "dpfj_select_engine", dpfj_select_engine(NULL, engine));
  return env.Undefined();
}

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  unsigned int cnt = 0;
  std::vector<DPFPDD_DEV_INFO> devs;
  for (int guard = 0; guard < 100; ++guard) {
    devs.resize(cnt);
    if (!devs.empty()) devs[0].size = sizeof(DPFPDD_DEV_INFO);
    int r = dpfpdd_query_devices(&cnt, devs.empty() ? NULL : devs.data());
    if (r == DPFPDD_SUCCESS) break;
    if (r != DPFPDD_E_MORE_DATA) ThrowDp(env, "dpfpdd_query_devices", r);
  }
  Napi::Array arr = Napi::Array::New(env, devs.size());
  for (size_t i = 0; i < devs.size(); ++i) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("name", std::string(devs[i].name));
    o.Set("vendor", std::string(devs[i].descr.vendor_name));
    o.Set("product", std::string(devs[i].descr.product_name));
    o.Set("serial", std::string(devs[i].descr.serial_num));
    o.Set("modality", devs[i].modality);
    o.Set("technology", devs[i].technology);
    o.Set("vendorId", devs[i].id.vendor_id);
    o.Set("productId", devs[i].id.product_id);
    arr[static_cast<uint32_t>(i)] = o;
  }
  return arr;
}

// ---------------- reader open/close/cancel ----------------

Napi::Value OpenReader(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsString()) throw Napi::Error::New(env, "open(name, exclusive): name must be a string");
  std::string name = info[0].As<Napi::String>();
  bool exclusive = info[1].IsBoolean() ? info[1].ToBoolean() : true;

  std::vector<char> buf(name.begin(), name.end());
  buf.push_back('\0');
  DPFPDD_DEV dev = NULL;
  int r = dpfpdd_open_ext(buf.data(),
                          exclusive ? DPFPDD_PRIORITY_EXCLUSIVE : DPFPDD_PRIORITY_COOPERATIVE,
                          &dev);
  if (r != DPFPDD_SUCCESS) ThrowDp(env, "dpfpdd_open_ext", r);

  auto entry = std::make_shared<HandleEntry>();
  entry->dev = dev;
  entry->dpi = FirstDpi(dev);

  std::lock_guard<std::mutex> lock(g_mtx);
  uint32_t h = g_nextHandle++;
  g_handles[h] = entry;
  return Napi::Number::New(env, h);
}

Napi::Value CloseReader(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t h = info[0].ToNumber().Uint32Value();
  std::shared_ptr<HandleEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_mtx);
    auto it = g_handles.find(h);
    if (it == g_handles.end()) throw Napi::Error::New(env, "invalid reader handle");
    entry = it->second;
    g_handles.erase(it);
  }
  dpfpdd_cancel(entry->dev);  // wake up any pending capture
  std::lock_guard<std::mutex> lock(g_mtx);
  if (entry->busy) {
    entry->closing = true;  // worker will close the device when capture returns
    return env.Undefined();
  }
  int r = dpfpdd_close(entry->dev);
  if (r != DPFPDD_SUCCESS) ThrowDp(env, "dpfpdd_close", r);
  return env.Undefined();
}

Napi::Value CancelCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);
  CheckDp(env, "dpfpdd_cancel", dpfpdd_cancel(entry->dev));
  return env.Undefined();
}

// ---------------- sync info calls ----------------

Napi::Value GetCapabilities(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);
  DPFPDD_DEV dev = entry->dev;

  unsigned int size = sizeof(unsigned int);
  int r = dpfpdd_get_device_capabilities(dev, reinterpret_cast<DPFPDD_DEV_CAPS*>(&size));
  if (r != DPFPDD_E_MORE_DATA && r != DPFPDD_SUCCESS) ThrowDp(env, "dpfpdd_get_device_capabilities", r);
  std::vector<unsigned char> buf(size);
  auto* caps = reinterpret_cast<DPFPDD_DEV_CAPS*>(buf.data());
  caps->size = size;
  CheckDp(env, "dpfpdd_get_device_capabilities", dpfpdd_get_device_capabilities(dev, caps));

  Napi::Object o = Napi::Object::New(env);
  o.Set("canCaptureImage", static_cast<bool>(caps->can_capture_image));
  o.Set("canStreamImage", static_cast<bool>(caps->can_stream_image));
  o.Set("canExtractFeatures", static_cast<bool>(caps->can_extract_features));
  o.Set("canMatch", static_cast<bool>(caps->can_match));
  o.Set("canIdentify", static_cast<bool>(caps->can_identify));
  o.Set("hasFpStorage", static_cast<bool>(caps->has_fp_storage));
  o.Set("indicatorType", caps->indicator_type);
  o.Set("hasPowerMgmt", static_cast<bool>(caps->has_pwr_mgmt));
  o.Set("hasCalibration", static_cast<bool>(caps->has_calibration));
  o.Set("pivCompliant", static_cast<bool>(caps->piv_compliant));
  Napi::Array res = Napi::Array::New(env, caps->resolution_cnt);
  for (unsigned int i = 0; i < caps->resolution_cnt; ++i) res[i] = caps->resolutions[i];
  o.Set("resolutions", res);
  return o;
}

Napi::Value GetStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);
  DPFPDD_DEV_STATUS ds = {};
  ds.size = sizeof(ds);
  CheckDp(env, "dpfpdd_get_device_status", dpfpdd_get_device_status(entry->dev, &ds));
  Napi::Object o = Napi::Object::New(env);
  o.Set("status", ds.status);
  o.Set("fingerDetected", static_cast<bool>(ds.finger_detected));
  return o;
}

// ---------------- capture (sync + async) ----------------

Napi::Value Capture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);

  uint32_t fmt = DPFPDD_IMG_FMT_PIXEL_BUFFER;
  uint32_t proc = DPFPDD_IMG_PROC_DEFAULT;
  uint32_t dpi = entry->dpi;
  uint32_t timeout = 5000;
  if (info[1].IsObject()) {
    Napi::Object o = info[1].As<Napi::Object>();
    fmt = OptObjU32(env, o, "fmt", fmt);
    proc = OptObjU32(env, o, "proc", proc);
    dpi = OptObjU32(env, o, "dpi", dpi);
    timeout = OptObjU32(env, o, "timeout", timeout);
  }
  if (dpi == 0) {
    dpi = FirstDpi(entry->dev);
    if (dpi == 0) throw Napi::Error::New(env, "reader reports no supported resolution");
  }

  {
    std::lock_guard<std::mutex> lock(g_mtx);
    if (entry->busy) throw Napi::Error::New(env, "capture already in progress on this handle");
    entry->busy = true;
  }
  CaptureOut out;
  out.code = DoCapture(entry->dev, fmt, proc, dpi, timeout, &out);
  {
    std::lock_guard<std::mutex> lock(g_mtx);
    entry->busy = false;
  }
  if (out.code != DPFPDD_SUCCESS) ThrowDp(env, "dpfpdd_capture", out.code);
  return BuildCaptureResult(env, out);
}

class CaptureWorker : public Napi::AsyncWorker {
 public:
  CaptureWorker(Napi::Promise::Deferred deferred, std::shared_ptr<HandleEntry> entry,
                uint32_t fmt, uint32_t proc, uint32_t dpi, uint32_t timeout)
      : AsyncWorker(deferred.Env()), deferred_(std::move(deferred)),
        entry_(std::move(entry)), fmt_(fmt), proc_(proc), dpi_(dpi), timeout_(timeout) {}

  // Runs on the thread pool: no Napi calls here.
  void Execute() override {
    out_.code = DoCapture(entry_->dev, fmt_, proc_, dpi_, timeout_, &out_);
    std::lock_guard<std::mutex> lock(g_mtx);
    entry_->busy = false;
    if (entry_->closing) {
      dpfpdd_close(entry_->dev);  // close() was requested while we were capturing
      entry_->closing = false;
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (out_.code != DPFPDD_SUCCESS) {
      deferred_.Reject(Napi::Error::New(env, "dpfpdd_capture failed (code " + Hex(out_.code) + ")").Value());
      return;
    }
    deferred_.Resolve(BuildCaptureResult(env, out_));
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::shared_ptr<HandleEntry> entry_;
  uint32_t fmt_, proc_, dpi_, timeout_;
  CaptureOut out_;
};

Napi::Value CaptureAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);

  uint32_t fmt = DPFPDD_IMG_FMT_PIXEL_BUFFER;
  uint32_t proc = DPFPDD_IMG_PROC_DEFAULT;
  uint32_t dpi = entry->dpi;
  uint32_t timeout = 5000;
  if (info[1].IsObject()) {
    Napi::Object o = info[1].As<Napi::Object>();
    fmt = OptObjU32(env, o, "fmt", fmt);
    proc = OptObjU32(env, o, "proc", proc);
    dpi = OptObjU32(env, o, "dpi", dpi);
    timeout = OptObjU32(env, o, "timeout", timeout);
  }
  if (dpi == 0) {
    dpi = FirstDpi(entry->dev);
    if (dpi == 0) throw Napi::Error::New(env, "reader reports no supported resolution");
  }

  {
    std::lock_guard<std::mutex> lock(g_mtx);
    if (entry->busy) throw Napi::Error::New(env, "capture already in progress on this handle");
    entry->busy = true;
  }

  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new CaptureWorker(deferred, entry, fmt, proc, dpi, timeout);
  worker->Queue();
  return deferred.Promise();
}

Napi::Value LedConfig(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);
  uint32_t id = OptU32(env, info[1], DPFPDD_LED_ALL);
  uint32_t mode = OptU32(env, info[2], DPFPDD_LED_CLIENT);
  CheckDp(env, "dpfpdd_led_config",
          dpfpdd_led_config(entry->dev, static_cast<DPFPDD_LED_ID>(id), static_cast<DPFPDD_LED_MODE_TYPE>(mode), NULL));
  return env.Undefined();
}

Napi::Value LedCtrl(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);
  uint32_t id = OptU32(env, info[1], DPFPDD_LED_ACCEPT);
  uint32_t cmd = OptU32(env, info[2], DPFPDD_LED_CMD_OFF);
  CheckDp(env, "dpfpdd_led_ctrl",
          dpfpdd_led_ctrl(entry->dev, static_cast<DPFPDD_LED_ID>(id), static_cast<DPFPDD_LED_CMD_TYPE>(cmd)));
  return env.Undefined();
}

Napi::Value SetPad(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto entry = GetEntry(info);
  unsigned char enable = (info[1].ToBoolean()) ? 1 : 0;
  CheckDp(env, "dpfpdd_set_parameter(PAD)",
          dpfpdd_set_parameter(entry->dev, DPFPDD_PARMID_PAD_ENABLE, sizeof(enable), &enable));
  return env.Undefined();
}

// ---------------- fingerjet: extraction / matching ----------------

Napi::Value CreateFmdFromRaw(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsBuffer()) throw Napi::Error::New(env, "createFmdFromRaw(image, opts): image must be a Buffer");
  Napi::Buffer<unsigned char> img = info[0].As<Napi::Buffer<unsigned char>>();
  Napi::Object o = info[1].IsObject() ? info[1].As<Napi::Object>() : Napi::Object::New(env);
  uint32_t width = OptObjU32(env, o, "width", 0);
  uint32_t height = OptObjU32(env, o, "height", 0);
  uint32_t dpi = OptObjU32(env, o, "dpi", 500);
  uint32_t fingerPos = OptObjU32(env, o, "fingerPos", DPFJ_POSITION_UNKNOWN);
  uint32_t cbeffId = OptObjU32(env, o, "cbeffId", 0);
  uint32_t fmdType = OptObjU32(env, o, "fmdType", DPFJ_FMD_ISO_19794_2_2005);
  if (width == 0 || height == 0) throw Napi::Error::New(env, "createFmdFromRaw: width and height are required");

  std::vector<unsigned char> fmd(MAX_FMD_SIZE);
  unsigned int fmdSize = MAX_FMD_SIZE;
  CheckDp(env, "dpfj_create_fmd_from_raw",
          dpfj_create_fmd_from_raw(img.Data(), img.Length(), width, height, dpi,
                                   static_cast<DPFJ_FINGER_POSITION>(fingerPos), cbeffId,
                                   static_cast<DPFJ_FMD_FORMAT>(fmdType), fmd.data(), &fmdSize));
  return Napi::Buffer<unsigned char>::Copy(env, fmd.data(), fmdSize);
}

Napi::Value CreateFmdFromFid(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsBuffer()) throw Napi::Error::New(env, "createFmdFromFid(fid, fidType, fmdType): fid must be a Buffer");
  Napi::Buffer<unsigned char> fid = info[0].As<Napi::Buffer<unsigned char>>();
  uint32_t fidType = OptU32(env, info[1], DPFJ_FID_ISO_19794_4_2005);
  uint32_t fmdType = OptU32(env, info[2], DPFJ_FMD_ISO_19794_2_2005);

  std::vector<unsigned char> fmd(MAX_FMD_SIZE);
  unsigned int fmdSize = MAX_FMD_SIZE;
  CheckDp(env, "dpfj_create_fmd_from_fid",
          dpfj_create_fmd_from_fid(static_cast<DPFJ_FID_FORMAT>(fidType), fid.Data(), fid.Length(),
                                   static_cast<DPFJ_FMD_FORMAT>(fmdType), fmd.data(), &fmdSize));
  return Napi::Buffer<unsigned char>::Copy(env, fmd.data(), fmdSize);
}

Napi::Value Compare(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsBuffer() || !info[2].IsBuffer())
    throw Napi::Error::New(env, "compare(fmd1, type1, fmd2, type2, view1, view2): fmds must be Buffers");
  Napi::Buffer<unsigned char> f1 = info[0].As<Napi::Buffer<unsigned char>>();
  Napi::Buffer<unsigned char> f2 = info[2].As<Napi::Buffer<unsigned char>>();
  uint32_t t1 = OptU32(env, info[1], DPFJ_FMD_ISO_19794_2_2005);
  uint32_t t2 = OptU32(env, info[3], DPFJ_FMD_ISO_19794_2_2005);
  uint32_t v1 = OptU32(env, info[4], 0);
  uint32_t v2 = OptU32(env, info[5], 0);

  unsigned int score = 0;
  CheckDp(env, "dpfj_compare",
          dpfj_compare(static_cast<DPFJ_FMD_FORMAT>(t1), f1.Data(), f1.Length(), v1,
                       static_cast<DPFJ_FMD_FORMAT>(t2), f2.Data(), f2.Length(), v2, &score));
  Napi::Object o = Napi::Object::New(env);
  o.Set("score", score);
  o.Set("falseMatchRate", static_cast<double>(score) / DPFJ_PROBABILITY_ONE);
  return o;
}

Napi::Value Identify(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsBuffer()) throw Napi::Error::New(env, "identify(probe, probeType, list, type, threshold): probe must be a Buffer");
  Napi::Buffer<unsigned char> probe = info[0].As<Napi::Buffer<unsigned char>>();
  uint32_t probeType = OptU32(env, info[1], DPFJ_FMD_ISO_19794_2_2005);
  if (!info[2].IsArray()) throw Napi::Error::New(env, "identify: list must be an array of Buffers");
  Napi::Array list = info[2].As<Napi::Array>();
  uint32_t type = OptU32(env, info[3], probeType);
  uint32_t threshold = OptU32(env, info[4], DPFJ_PROBABILITY_ONE / 100000);

  uint32_t n = list.Length();
  std::vector<std::vector<unsigned char>> store(n);
  std::vector<unsigned char*> ptrs(n);
  std::vector<unsigned int> sizes(n);
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Buffer<unsigned char> b = list.Get(i).As<Napi::Buffer<unsigned char>>();
    store[i].assign(b.Data(), b.Data() + b.Length());
    ptrs[i] = store[i].data();
    sizes[i] = static_cast<unsigned int>(b.Length());
  }

  unsigned int candCnt = n;
  std::vector<DPFJ_CANDIDATE> cands(n > 0 ? n : 1);
  for (auto& c : cands) c.size = sizeof(DPFJ_CANDIDATE);
  CheckDp(env, "dpfj_identify",
          dpfj_identify(static_cast<DPFJ_FMD_FORMAT>(probeType), probe.Data(), probe.Length(), 0,
                        static_cast<DPFJ_FMD_FORMAT>(type), n, ptrs.data(), sizes.data(),
                        threshold, &candCnt, cands.data()));

  Napi::Array out = Napi::Array::New(env, candCnt);
  for (unsigned int i = 0; i < candCnt; ++i) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("index", cands[i].fmd_idx);
    o.Set("viewIdx", cands[i].view_idx);
    out[i] = o;
  }
  return out;
}

// ---------------- fingerjet: enrollment ----------------

Napi::Value StartEnrollment(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  uint32_t fmt = OptU32(env, info[0], DPFJ_FMD_DP_REG_FEATURES);
  CheckDp(env, "dpfj_start_enrollment", dpfj_start_enrollment(static_cast<DPFJ_FMD_FORMAT>(fmt)));
  return env.Undefined();
}

Napi::Value AddToEnrollment(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!info[0].IsBuffer()) throw Napi::Error::New(env, "addToEnrollment(fmd, type): fmd must be a Buffer");
  Napi::Buffer<unsigned char> fmd = info[0].As<Napi::Buffer<unsigned char>>();
  uint32_t type = OptU32(env, info[1], DPFJ_FMD_DP_PRE_REG_FEATURES);
  int r = dpfj_add_to_enrollment(static_cast<DPFJ_FMD_FORMAT>(type), fmd.Data(), fmd.Length(), 0);
  if (r == DPFJ_E_MORE_DATA) return Napi::Boolean::New(env, false);  // needs more samples
  CheckDp(env, "dpfj_add_to_enrollment", r);
  return Napi::Boolean::New(env, true);  // enrollment ready
}

Napi::Value CreateEnrollmentFmd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  unsigned int fmdSize = 0;
  int r = dpfj_create_enrollment_fmd(NULL, &fmdSize);
  if (r != DPFJ_E_MORE_DATA && r != DPFJ_SUCCESS) ThrowDp(env, "dpfj_create_enrollment_fmd", r);
  std::vector<unsigned char> fmd(fmdSize);
  CheckDp(env, "dpfj_create_enrollment_fmd", dpfj_create_enrollment_fmd(fmd.data(), &fmdSize));
  return Napi::Buffer<unsigned char>::Copy(env, fmd.data(), fmdSize);
}

Napi::Value FinishEnrollment(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CheckDp(env, "dpfj_finish_enrollment", dpfj_finish_enrollment());
  return env.Undefined();
}

// ---------------- constants ----------------

Napi::Object MakeConstants(Napi::Env env) {
  Napi::Object c = Napi::Object::New(env);

  Napi::Object imgFmt = Napi::Object::New(env);
  imgFmt.Set("PIXEL_BUFFER", DPFPDD_IMG_FMT_PIXEL_BUFFER);
  imgFmt.Set("ANSI381", DPFPDD_IMG_FMT_ANSI381);
  imgFmt.Set("ISOIEC19794", DPFPDD_IMG_FMT_ISOIEC19794);
  c.Set("IMG_FMT", imgFmt);

  Napi::Object imgProc = Napi::Object::New(env);
  imgProc.Set("DEFAULT", DPFPDD_IMG_PROC_DEFAULT);
  imgProc.Set("PIV", DPFPDD_IMG_PROC_PIV);
  imgProc.Set("ENHANCED", DPFPDD_IMG_PROC_ENHANCED);
  imgProc.Set("ENHANCED_2", DPFPDD_IMG_PROC_ENHANCED_2);
  imgProc.Set("UNPROCESSED", DPFPDD_IMG_PROC_UNPROCESSED);
  c.Set("IMG_PROC", imgProc);

  Napi::Object q = Napi::Object::New(env);
  q.Set("GOOD", DPFPDD_QUALITY_GOOD);
  q.Set("TIMED_OUT", DPFPDD_QUALITY_TIMED_OUT);
  q.Set("CANCELED", DPFPDD_QUALITY_CANCELED);
  q.Set("NO_FINGER", DPFPDD_QUALITY_NO_FINGER);
  q.Set("FAKE_FINGER", DPFPDD_QUALITY_FAKE_FINGER);
  q.Set("FINGER_TOO_LEFT", DPFPDD_QUALITY_FINGER_TOO_LEFT);
  q.Set("FINGER_TOO_RIGHT", DPFPDD_QUALITY_FINGER_TOO_RIGHT);
  q.Set("FINGER_TOO_HIGH", DPFPDD_QUALITY_FINGER_TOO_HIGH);
  q.Set("FINGER_TOO_LOW", DPFPDD_QUALITY_FINGER_TOO_LOW);
  q.Set("FINGER_OFF_CENTER", DPFPDD_QUALITY_FINGER_OFF_CENTER);
  q.Set("SCAN_SKEWED", DPFPDD_QUALITY_SCAN_SKEWED);
  q.Set("SCAN_TOO_SHORT", DPFPDD_QUALITY_SCAN_TOO_SHORT);
  q.Set("SCAN_TOO_LONG", DPFPDD_QUALITY_SCAN_TOO_LONG);
  q.Set("SCAN_TOO_SLOW", DPFPDD_QUALITY_SCAN_TOO_SLOW);
  q.Set("SCAN_TOO_FAST", DPFPDD_QUALITY_SCAN_TOO_FAST);
  q.Set("SCAN_WRONG_DIRECTION", DPFPDD_QUALITY_SCAN_WRONG_DIRECTION);
  q.Set("READER_DIRTY", DPFPDD_QUALITY_READER_DIRTY);
  c.Set("QUALITY", q);

  Napi::Object fid = Napi::Object::New(env);
  fid.Set("ANSI_381_2004", DPFJ_FID_ANSI_381_2004);
  fid.Set("ISO_19794_4_2005", DPFJ_FID_ISO_19794_4_2005);
  c.Set("FID_FORMAT", fid);

  Napi::Object fmd = Napi::Object::New(env);
  fmd.Set("ANSI_378_2004", DPFJ_FMD_ANSI_378_2004);
  fmd.Set("ISO_19794_2_2005", DPFJ_FMD_ISO_19794_2_2005);
  fmd.Set("DP_PRE_REG", DPFJ_FMD_DP_PRE_REG_FEATURES);
  fmd.Set("DP_REG", DPFJ_FMD_DP_REG_FEATURES);
  fmd.Set("DP_VER", DPFJ_FMD_DP_VER_FEATURES);
  c.Set("FMD_FORMAT", fmd);

  Napi::Object led = Napi::Object::New(env);
  led.Set("MAIN", DPFPDD_LED_MAIN);
  led.Set("REJECT", DPFPDD_LED_REJECT);
  led.Set("ACCEPT", DPFPDD_LED_ACCEPT);
  led.Set("FINGER_DETECT", DPFPDD_LED_FINGER_DETECT);
  led.Set("ALL", DPFPDD_LED_ALL);
  led.Set("MODE_AUTO", DPFPDD_LED_AUTO);
  led.Set("MODE_CLIENT", DPFPDD_LED_CLIENT);
  led.Set("CMD_OFF", DPFPDD_LED_CMD_OFF);
  led.Set("CMD_ON", DPFPDD_LED_CMD_ON);
  c.Set("LED", led);

  Napi::Object eng = Napi::Object::New(env);
  eng.Set("DPFJ", DPFJ_ENGINE_DPFJ);
  eng.Set("INNOVATRICS_ANSIISO", DPFJ_ENGINE_INNOVATRICS_ANSIISO);
  eng.Set("DPFJ7", DPFJ_ENGINE_DPFJ7);
  c.Set("ENGINE", eng);

  c.Set("PROBABILITY_ONE", static_cast<double>(DPFJ_PROBABILITY_ONE));
  c.Set("MAX_FMD_SIZE", MAX_FMD_SIZE);
  return c;
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, DpInit));
  exports.Set("exit", Napi::Function::New(env, DpExit));
  exports.Set("version", Napi::Function::New(env, DpVersion));
  exports.Set("selectEngine", Napi::Function::New(env, SelectEngine));
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));

  exports.Set("open", Napi::Function::New(env, OpenReader));
  exports.Set("close", Napi::Function::New(env, CloseReader));
  exports.Set("cancel", Napi::Function::New(env, CancelCapture));
  exports.Set("getCapabilities", Napi::Function::New(env, GetCapabilities));
  exports.Set("getStatus", Napi::Function::New(env, GetStatus));
  exports.Set("capture", Napi::Function::New(env, Capture));
  exports.Set("captureAsync", Napi::Function::New(env, CaptureAsync));
  exports.Set("ledConfig", Napi::Function::New(env, LedConfig));
  exports.Set("ledCtrl", Napi::Function::New(env, LedCtrl));
  exports.Set("setPad", Napi::Function::New(env, SetPad));

  exports.Set("createFmdFromRaw", Napi::Function::New(env, CreateFmdFromRaw));
  exports.Set("createFmdFromFid", Napi::Function::New(env, CreateFmdFromFid));
  exports.Set("compare", Napi::Function::New(env, Compare));
  exports.Set("identify", Napi::Function::New(env, Identify));

  exports.Set("startEnrollment", Napi::Function::New(env, StartEnrollment));
  exports.Set("addToEnrollment", Napi::Function::New(env, AddToEnrollment));
  exports.Set("createEnrollmentFmd", Napi::Function::New(env, CreateEnrollmentFmd));
  exports.Set("finishEnrollment", Napi::Function::New(env, FinishEnrollment));

  exports.Set("C", MakeConstants(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(uareu, InitModule)
