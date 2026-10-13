# 测试说明

最近验证版本：2026-10-13，共 **49 项测试通过**：12 项 Rust、19 项 Node、18 项 Chromium。strict 类型检查、Rust 格式检查、原生/wasm32 Clippy 和生产构建均通过。

## 覆盖范围

| 模块 | 检查内容 |
| --- | --- |
| 数学 | TRS、列主序矩阵、点变换；与 Three.js 比较旋转、负缩放和非均匀缩放结果 |
| 场景图 | 无序父节点、改父节点、循环拒绝、脏更新传播、空场景和 20,000 层深度 |
| WASM 内存 | 内存增长后重新建立视图，复制结果可独立保留，重复创建与释放 |
| 可见性 | 三种场景的可见节点集合与 Three.js Frustum/Sphere 对齐 |
| 几何与相机 | 三角形外向绕序，look-at 和透视矩阵与 Three.js 对齐 |
| 绘制 | 逐对象及实例化路径的非空像素、WebGL 错误码和画面一致性 |
| 基准测试 | 相同采样条件、普通绘制与实例化调用数、JSON 导出、取消及尺寸变化中断 |
| 上下文恢复 | 单边/双边丢失、恢复后像素、相机和暂停状态，自定义 TRS 保留 |
| 资源释放 | 丢失期间禁止绘制，dispose 后不得重建；无效队列不得复用旧绘制列表 |
| GPU 计时 | 结果未就绪、纳秒换算、disjoint、扩展缺失、上下文失效及查询释放 |

## 浏览器检查

在逐对象模式下拦截实际 WebGL 调用，500 对象用例的两边每帧都是 500 次普通绘制、0 次实例化调用。正式报告还会核对双方每个样本的可见数和三角形数。

像素比较使用 RGB 平均绝对误差，阈值为 3/255。覆盖街区、仓库和机械阵列，以及普通 Mesh、InstancedMesh 两种对照。

布局检查覆盖 532×863、390×844、1024×640、1280×720、1440×900，确认控件、双画布和完整结果不溢出，测试前后画布尺寸保持一致。另有 20,000 对象场景的重建与释放检查。

上下文恢复使用 `WEBGL_lose_context` 主动注入故障。恢复后会重新检查像素，并完成一次新的性能测试。

## 运行

```bash
npm run check
cargo clippy --target wasm32-unknown-unknown --locked -- -D warnings
npm test
npm run build
```

单独检查恢复路径：

```bash
npm run test:e2e -- --grep 'context recovery|context loss cancels|public Engine retains'
```

截图、trace 和测试报告保存在 `test-results/`，CI 会上传 artifact，该目录不提交到仓库。

## 验证边界

本地环境为 macOS / Apple Silicon、Rust 1.99.0、Node.js 20.20.2 和 Chromium 156；CI 使用 Linux / Node.js 22。Firefox、Safari 和驱动永久故障尚未实际验收。

Headless Chromium 可能使用软件渲染。自动化跑分用于验证采样流程，不代表真实显卡性能；模拟 GPU 查询测试也不等同于硬件计时验证。
