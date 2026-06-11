@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set "CUDA_PATH=D:\llama-turbo\cuda"
set "PATH=D:\llama-turbo\cuda\bin;%PATH%"
cd /d D:\llama-turbo\atomic

echo === CONFIGURE ===
cmake -G Ninja -B build ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DGGML_CUDA=ON ^
  -DCMAKE_CUDA_COMPILER=D:/llama-turbo/cuda/bin/nvcc.exe ^
  -DCUDAToolkit_ROOT=D:/llama-turbo/cuda ^
  -DCMAKE_CUDA_ARCHITECTURES=120 ^
  -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler ^
  -DGGML_NATIVE=ON ^
  -DLLAMA_CURL=OFF ^
  -DLLAMA_BUILD_TESTS=OFF ^
  -DLLAMA_BUILD_EXAMPLES=OFF
if errorlevel 1 ( echo CONFIGURE_FAILED & exit /b 1 )

echo === BUILD ===
cmake --build build --config Release -j 20 --target llama-server llama-cli llama-bench llama-quantize
echo BUILD_EXIT=%errorlevel%
