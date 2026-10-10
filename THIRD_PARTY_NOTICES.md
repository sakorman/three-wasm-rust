# 来源与许可

## 设计参考

本项目的实验主题、Three.js 风格场景变换、原生语言执行 WebGL、数学/跨语言调用性能对照的方向，参考了 [takahirox/three.wasm-experimental](https://github.com/takahirox/three.wasm-experimental)。研究时参考的提交为 `9009842ad7baa05d959cfb8cdab86f8b5cd01539`。

本项目重新用 Rust 和现代 JavaScript 编写实现，没有打包原项目的 C/C++、Emscripten 产物或修改版 Three.js r98，也不继承其提交历史。为保留清晰的来源信息，附上原项目的 MIT 许可：

```text
MIT License

Copyright (c) 2018 Takahiro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 依赖

- [Three.js](https://github.com/mrdoob/three.js)：MIT；用于引擎对照组，以及旧 CPU 实验页的相机、几何体与混合渲染。新版自研引擎路径不依赖 Three.js。
- [wasm-bindgen / web-sys](https://github.com/wasm-bindgen/wasm-bindgen)：MIT / Apache-2.0；负责 Rust 与 JavaScript / WebGL 的绑定。
- [bytemuck](https://github.com/Lokathor/bytemuck)：Zlib / Apache-2.0 / MIT；安全地将数值切片解释为 GPU 上传字节。
- Vite、wasm-pack 和 Playwright 为开发依赖，许可和准确版本以各包及锁文件为准。

发布或分发依赖时，应同时遵循对应依赖的许可。本项目自身使用 [MIT](LICENSE)。
