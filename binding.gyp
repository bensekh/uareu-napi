{
  "targets": [
    {
      "target_name": "uareu",
      "sources": [ "src/addon.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "C:/Program Files/DigitalPersona/U.are.U SDK/Include"
      ],
      "library_dirs": [
        "C:/Program Files/DigitalPersona/U.are.U SDK/Windows/Lib/x64"
      ],
      "libraries": [
        "dpfpdd.lib",
        "dpfj.lib"
      ],
      "defines": [ "NAPI_VERSION=8" ],
      "conditions": [
        ["OS=='win'", {
          "defines": [ "UNICODE", "_UNICODE" ],
          "cflags!": [ "-fno-exceptions" ],
          "cflags_cc!": [ "-fno-exceptions" ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "LanguageStandard": "stdcpp17",
              "AdditionalOptions": [ "/std:c++17" ]
            }
          }
        }]
      ]
    }
  ]
}
