# Three × Rust

[![CI](https://github.com/sakorman/three-wasm-rust/actions/workflows/ci.yml/badge.svg)](https://github.com/sakorman/three-wasm-rust/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)

[在线演示](https://sakorman.github.io/three-wasm-rust/) · [CPU 小型测试](https://sakorman.github.io/three-wasm-rust/lab.html)

一个用 Rust 和 TypeScript 写的浏览器场景引擎。Rust 编译成 WASM，负责层级更新、可见性判断、批次整理和 WebGL2 绘制提交。相机、几何体生成和 TS 接口也在仓库里，可以单独拿出来使用。

首页把它和 Three.js 放在同一个场景里对照。两边同步视角，正式测试时逐组运行，避免并排预览互相抢资源。除了普通 Three.js Mesh，也保留了 InstancedMesh 优化组。

目前是 **0.2 引擎原型**，适合研究不透明几何体场景和 CPU/GPU 分工。还没有纹理、PBR、阴影、模型加载或 3DGS，不能直接替代完整的 Three.js。

![引擎与 Three.js 场景对照](docs/demo.png)

## 现在有哪些东西

- **场景图**：固定数量的节点、多根层级、改父节点、输入校验。局部变换没变化时跳过矩阵重算，父节点变化会传递给后代。
- **渲染队列**：球包围体视锥剔除，按几何体和材质分组，将可见矩阵打包到连续内存。
- **WebGL2 渲染器**：几何体、材质注册，一次上传矩阵，每个非空批次一次实例化绘制。深度测试、背面剔除、简单面光照和无光照颜色。
- **TS 接口**：引擎生命周期、轨道相机、盒体/圆柱/球体生成。`web/engine/` 不导入 Three.js。
- **场景与对照**：三个场景，500–20,000 个可绘制对象，三套实现，共享输入、相机、几何体、shader 和像素尺寸。
- **测量**：CPU 中位数/P95、帧间隔、FPS、可用时的 GPU 查询结果、draw call、可见对象数和 JSON 原始样本。

## 三个场景

| 场景 | 内容 | 主要观察什么 |
| --- | --- | --- |
| 街区 | 建筑、屋顶、窗带、路标和树木，少量路标旋转 | 大量静态对象中的稀疏更新 |
| 仓库 | 货架立柱、层板、箱体和桶 | 静态场景、材质复用、自动批次 |
| 机械阵列 | 底座、立柱、转臂和末端关节 | 父子节点动画和矩阵传播 |

“对象数”是可绘制对象数量，包含地面；分组和关节也有场景节点，所以节点数会更多。场景使用固定种子 2026，重复选择相同场景和数量可以得到相同输入。

拖动任一画布会同时改变两边视角。把镜头拉近后，可以观察视锥剔除对可见数量和绘制工作的影响。

## 三组实现怎么比较

| 实现 | 场景更新 | 可见性与绘制 |
| --- | --- | --- |
| Rust 引擎 | WASM 场景图，脏矩阵更新 | Rust 球剔除、分组、实例化提交 |
| Three.js 普通 Mesh | 常规 Object3D/Mesh 自动矩阵更新 | Three.js 内置剔除，每个可见对象一个 Mesh draw |
| Three.js 实例化 | Object3D 关闭自动局部矩阵更新，只更新动画节点 | Three.js Frustum 检查每个对象，按同样的几何/材质组合创建 InstancedMesh |

三个实现都使用实际场景层级。普通 Mesh 组直接调用 Three.js 的渲染器，没有人工添加额外计算。优化组同时减少矩阵更新和 draw call，作为更接近优化后应用的参照。

**算法和数据布局也会影响结果。** 普通 Mesh 到实例化的差距包括批次策略的收益；Rust f32 与 JS Number 的精度也不同。这里比较的是三套具体实现，不能把倍数全部归因于 Rust。

所有组最终都由 GPU 光栅化。Rust 渲染器只负责准备资源与提交命令。

## 跑起来

需要 Node.js 20.19+（推荐 22 LTS）、Rust stable、npm 和支持 WebGL2 的浏览器。

```bash
# 尚未安装 Rust 时，先从 https://rustup.rs 安装
rustup target add wasm32-unknown-unknown

git clone https://github.com/sakorman/three-wasm-rust.git
cd three-wasm-rust
npm ci
npm run dev
```

默认地址是 `http://127.0.0.1:5173`。启动前会编译 WASM；第一次运行需要下载 Rust 依赖和绑定工具。

只修改 TS 时使用 `npm run dev:web`。修改 Rust 后执行 `npm run build:wasm` 并刷新，Vite 不会自动编译 Rust。

```bash
npm run build       # WASM + strict 类型检查 + 两个页面的静态构建
npm run preview     # 预览 dist/
```

构建产物使用相对路径，可以部署到 GitHub Pages 的仓库子路径。请通过 HTTP 服务访问，不能直接双击 HTML。

## 在自己的页面使用引擎

`web/engine/index.ts` 是源码入口，不依赖 Three.js。下面的例子可放到使用 Vite 的页面中：

```ts
import { init, Engine, OrbitCamera, createEngineScene } from './web/engine/index.ts';

await init();
const canvas = document.querySelector('canvas');
if (!canvas) throw new Error('缺少 canvas');
canvas.width = 960;
canvas.height = 600;

const data = createEngineScene('city', 2000);
const engine = new Engine(canvas, data);
const camera = new OrbitCamera();
camera.reset(data.extent);

let request = 0;
function frame(now: number) {
  const stats = engine.frame(now / 1000, camera.frame(canvas.width / canvas.height), true);
  // stats: updateMs、prepareMs、submitMs、cpuMs、visible、draws、triangles、updated
  request = requestAnimationFrame(frame);
}
request = requestAnimationFrame(frame);

// 页面或组件销毁时：
// cancelAnimationFrame(request);
// camera.dispose();
// engine.dispose();
```

自定义场景可以直接构造 `EngineScene`，具体字段见 [场景接口](web/engine/types.ts)。几何体用顶点/索引数组表示，材质指定 RGB 颜色和是否使用面光照；节点使用 10 个 f32 的 TRS 数据。包围球须以几何体局部原点为中心，并覆盖所有顶点。

`Engine` 封装了资源创建、动画节点更新、队列准备和绘制。需要更细的控制时，可以直接使用生成的 `SceneGraph`、`RenderQueue` 和 `EngineRenderer` 类。它们的接口和生命周期见 [实现笔记](docs/design.md)。

目前节点数量、几何体和材质在一次场景生命周期内固定；更新 TRS 或父子关系可以复用场景，增删对象或更换资源时重建。类型声明由 wasm-bindgen 生成，根目录尚未作为 npm 包发布。

## 测试结果怎么看

并排预览显示的是两个实现同时运行时的状态。点击“运行三组对照”后，页面暂停预览，一次只提交一个后端的绘制命令。

- 快速测试：每组每轮预热 8 帧，再记录 24 帧，轮换顺序跑 3 轮，每组 72 个样本。
- 完整测试：每组每轮预热 20 帧，再记录 60 帧，共 180 个样本。
- 每组都从同一个动画时间序列开始，使用采样前冻结的相机、对象数量、剔除设置和画布尺寸。
- 切到后台、改变画布尺寸或点击取消，会终止本次测试。正式测试期间禁用场景和相机操作。

| 指标 | 含义 |
| --- | --- |
| CPU 中位 / P95 | 每帧更新、准备、提交的总耗时；P95 用来看较慢帧 |
| 帧间隔 / FPS | 连续 requestAnimationFrame 的间隔及平均帧率，包含刷新率限制和浏览器调度 |
| GPU 中位 | EXT_disjoint_timer_query_webgl2 的异步查询结果，围绕绘制提交采样，不调用 gl.finish |
| Draw / 可见 | draw call 数和提交绘制的对象数 |
| 更新 / 准备 / 提交 | CPU 三个阶段各自的中位数，不能简单相加得到总耗时中位数 |

普通 Three.js 的内部剔除和列表排序发生在 `render()` 中，因此计入“提交”；Rust 和实例化组在“准备”阶段完成剔除和打包。比较总 CPU 耗时更直接。

GPU 查询不可用时显示“不可用”，遇到 disjoint 则丢弃该组 GPU 样本。查询包围绘制提交，包括驱动提交过程中可能产生的 GPU 空闲间隔，不能把它当作纯片元着色时间。Headless Chromium 可能使用软件渲染，不适合代表真实显卡性能。

JSON 报告包含全部 CPU/帧间隔样本、有效 GPU 样本、三轮顺序、浏览器、相机矩阵、对象/节点数量、画布尺寸和设置。没有预填的跑分，也不承诺 Rust 总是更快。计时器精度不足时不推算倍数。

原来的 JS / WASM 数学测试保留在 [CPU 小型测试](https://sakorman.github.io/three-wasm-rust/lab.html)。它只比较两套计算实现，场景矩阵测试强制重算所有节点，不使用脏标记跳过工作。

## 类型与测试

WASM 接口从 `pkg/three_wasm_rust.d.ts` 导入；Three.js 使用匹配 r186 的 `@types/three`。其余使用 TS 标准库及项目自己的接口，开启 strict。数组长度、循环引用、包围体和 GPU 资源生命周期仍需运行时校验。

```bash
npx playwright install chromium
npm run check
cargo clippy --target wasm32-unknown-unknown --locked -- -D warnings
npm test
npm run build
```

`npm test` 先测试 Rust、编译 WASM，再做类型检查、Node 差分和浏览器测试。单独运行 `npm run typecheck` 或 integration/e2e 前，需要已有 `pkg/` 构建产物。

验证内容包括脏更新传播、循环检查、相机矩阵、三个场景的可见集合、基础几何体朝向，以及 Rust 与两种 Three.js 路径的像素差异。完整记录见 [测试记录](docs/verification.md)。

## 目录

```text
src/
  lib.rs                 场景图、脏更新、WASM 数学接口
  math.rs                矩阵与 TRS
  queue.rs               视锥剔除、可见集合、批次矩阵打包
  engine_renderer.rs     多几何体/材质的 WebGL2 渲染器
  renderer.rs            旧实验使用的单批次渲染器
web/
  engine/                引擎 TS 接口、相机、几何体、场景、共享 GLSL
  compare/               Three.js 对照实现、GPU 计时、串行采样
  engine-main.ts         引擎对照页
  main.ts                旧 CPU 实验页
index.html               引擎与 Three.js 对照
lab.html                 CPU 小型测试
```

## 更新在线演示

推送代码后，在 **Actions → Deploy demo to GitHub Pages → Run workflow** 选择 `main`。普通 CI 只验证，不会自动发布。Fork 首次部署时，在仓库 **Settings → Pages** 将 Source 设为 **GitHub Actions**。

## 常见问题

**找不到 cargo**：安装 Rust 后重启终端；macOS/Linux 也可运行 `source "$HOME/.cargo/env"`。

**找不到 pkg 或 WASM 类型**：运行 `npm run build:wasm`。生成文件不提交到仓库，不要手工修改 `.d.ts`。

**Apple Silicon 上 wasm-pack 提示 Unrecognized target**：可能会回退到源码安装 wasm-bindgen。可以安装与 Cargo.lock 相同版本的官方 CLI；当前为 `cargo install wasm-bindgen-cli --version 0.2.129 --locked`。

**GPU 一栏不可用**：浏览器没有提供计时扩展，或查询未返回有效结果。CPU 和帧间隔测试仍可使用。

**CPU 快很多，FPS 却一样**：两组可能都达到屏幕刷新率上限，或瓶颈在 GPU。分别看 CPU、帧间隔和 GPU 查询结果。

**画面丢失**：上下文丢失目前需要刷新页面重建，尚未实现自动恢复。

## 文档与许可

[实现笔记](docs/design.md) · [数学与场景 API](docs/math-api.md) · [测试记录](docs/verification.md) · [更新记录](CHANGELOG.md)

MIT License。第三方来源与依赖记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
