# 测试说明

最近验证日期：2026-10-19，共 **115 项测试通过**：31 项 Rust、35 项 Node、49 项 Chromium。strict 类型检查、Rust 格式检查、原生/wasm32 Clippy 和生产构建均通过。

## 覆盖范围

| 模块 | 检查内容 |
| --- | --- |
| 数学 | TRS、列主序矩阵、点变换；与 Three.js 比较旋转、负缩放和非均匀缩放结果 |
| 乘法精度 | 大数相消保留局部偏移、中间乘积溢出后相消、最终溢出拒绝；单矩阵和批量结果与 Three.js 比较 |
| 点投影 | 等价齐次缩放、负 w、分母抵消、乘积溢出后的有限比值；零 w 与最终溢出拒绝，批量失败不修改输入 |
| 场景图 | 无序父节点、改父节点、循环拒绝、脏更新传播、空场景和 20,000 层深度 |
| 场景有效性 | 层级矩阵溢出、多个无效分支逐一修复、未更新及已释放场景、跨场景队列拒绝 |
| WASM 内存 | 内存增长后重新建立视图，复制结果可独立保留，重复创建与释放 |
| 可见性 | 三种场景的可见节点集合与 Three.js Frustum/Sphere 对齐 |
| 包围球 | 非原点球心、父子变换、旋转与负缩放；零半径边界、输入校验和更新后的队列失效 |
| 剔除数值 | 微小剪切的解析拉伸上界，1e-30 / 1e30 缩放与半径组合，等价齐次投影矩阵 |
| 几何与相机 | 三角形外向绕序，look-at 和透视矩阵与 Three.js 对齐 |
| 绘制 | 逐对象及实例化路径的非空像素、WebGL 错误码和画面一致性 |
| 镜像 | 父节点镜像、双重镜像、缩放符号变更、CW/CCW 批次切换；与普通 Three.js Mesh 比较单面三角形正反视图 |
| 光照 | ±1e8 世界平移、1e-12 / 1e12 缩放、镜像和 unlit；实际像素与解析面法线比较 |
| 基准测试 | 相同采样条件、普通绘制与实例化调用数、JSON 导出、取消及尺寸变化中断 |
| 上下文恢复 | 单边/双边丢失、恢复后像素、相机和暂停状态，自定义 TRS 保留 |
| 资源释放 | 丢失期间禁止绘制，dispose 后不得重建；无效队列不得复用旧绘制列表 |
| 材质更新 | 共享材质颜色与 unlit 更新，连续更新不重建 GPU 资源，无效编辑保持原值，丢失期间修改及恢复后像素 |
| 几何更新 | 固定拓扑的顶点上传、跨组共享引用、保守包围球、剔除更新、退化三角形、输入隔离及恢复后顶点 |
| 拓扑替换 | 顶点/索引数量变化、共享资源引用、绘制三角形统计、分配失败回滚、临时与旧句柄释放、恢复后拓扑 |
| GPU 计时 | 样本完整性、非法时长、重复 begin、dispose 后禁用、disjoint、扩展缺失、上下文失效及查询释放 |

## 浏览器检查

在逐对象模式下拦截实际 WebGL 调用，500 对象用例的两边每帧都是 500 次普通绘制、0 次实例化调用。正式报告还会核对双方每个样本的可见数和三角形数。

像素比较使用 RGB 平均绝对误差，阈值为 3/255。覆盖街区、仓库和机械阵列，以及普通 Mesh、InstancedMesh 两种对照。

布局检查覆盖 532×863、390×844、1024×640、1280×720、1440×900，确认控件、双画布和完整结果不溢出，测试前后画布尺寸保持一致。另有 20,000 对象场景的重建与释放检查。

上下文恢复使用 `WEBGL_lose_context` 主动注入故障。恢复后会重新检查像素，并完成一次新的性能测试。

镜像回归使用 256×256 画布和四个单面三角形。修复前，混合正负缩放的 Rust 逐对象路径只得到 4,710 个着色像素，普通 Three.js Mesh 为 9,419 个，RGB 平均误差为 9.02/255。修复后两条 Rust 路径及 Three.js 实例化适配器均与普通 Mesh 对齐；从背面观察时着色像素为零。用例还检查缩放符号变化后的批次迁移，混合朝向为两次实例化绘制，统一朝向为一次。

非原点用例将三角形放在局部 x≈10 处，使用球心 `(10, 0, 0)`、半径 0.75。仅提供该半径、保持原点球心时，Rust 剔除后没有着色像素；正确球心下与关闭剔除的参考画面一致，为 2,730 个着色像素。相机移动后可见对象由 2 个变为 1 个。逐对象、实例化和上下文恢复均检查画面与可见数，另用 500 个包围球、三个视角做真实 WASM 与 Three.js 差分测试。

剪切回归用非均匀父缩放 `(1.000008, 1, 1)` 和子节点 45° 旋转。单位球中心位于 x≈2.000006 时，球面有一点落在 x≈0.999998，已进入右裁剪面 x=1。原最大列长度约 1.000004，会错误剔除整个对象；新的保守上界保留它。浏览器用放大的边缘三角形检查实际像素，两种 Rust 路径开启与关闭剔除的画面完全一致。

剪切用例不把 Three.js 原生包围球算法作为正确性依据：该路径也会漏掉上述对象。标准场景仍逐样本检查两边工作量，自定义剪切场景须关闭剔除，或接受报告因工作量不同而终止。

溢出回归将父子缩放都设为 1e20。修复前，世界矩阵出现三个非有限值，关闭剔除后队列仍接受一个可见对象及 16 个矩阵元素；旧队列也继续报告可见。现在更新明确报错，队列失效且不能重新准备。浏览器拦截清屏、矩阵上传及 draw 调用，逐对象、实例化和旧 RustRenderer 在这些错误路径上均为零次提交；修正变换并重新准备后，像素与错误发生前完全一致。

光照回归使用斜面 z=x。修复前，沿 z 平移 1e8 后，Rust 与 Three.js 共享 shader 都将斜面算成近似水平面，中心像素为 `[171, 76, 38]`，红色通道比解析结果 114 高出 57。修复后，两种绘制策略在原点和 ±1e8 平移下均与解析结果对齐，每通道误差不超过 2/255；同时检查极端缩放、镜像、unlit 及旧实验页。该用例验证光照稳定性，不证明大坐标下的投影或深度精度。

GPU 样本完整性用例模拟每四次查询分配失败一次。修复前，72/96 个返回值仍被标为 `available` 并计算中位数；现在该侧标为 `incomplete`，页面显示“采样不全”，JSON 中位数为 null，保留 72 个原始结果和预期数量 96。另一侧完整的 96 个结果仍可显示中位数。逐对象与实例化两种对照均验证完整及缺失两种情况。模拟扩展只用于验证采样流程，不代表实际 GPU 性能。

矩阵抵消用例将父节点旋转 45° 并沿 x 缩放 1e8，再用平移抵消子节点的 x 偏移。原实现把子节点剩余的世界位移 `[-0.35355338, 0.35355341, 0]` 算成 `[0, 0, 0]`；修复后脏更新与全量更新都保留该偏移。浏览器将层级场景与直接设置解析位置的平面场景比较，两种绘制路径的 RGB 平均误差均小于 0.05/255。另检查 1e20、1e30 乘积相消得到有限结果，以及真实溢出的明确拒绝。

点投影回归中，原实现对 `1e-30 × I` 和点 `[1, 2, 3]` 报“w 为零”，对 `1e30 × I` 和约 `[1e20, 2e20, 0]` 返回 Infinity；修复后都返回对应的有限输入点。另以 Three.js 对照透视矩阵的正负缩放，检查分母相消、零 w、最终溢出和输入不变。浏览器将投影后的三角形与解析顶点直接绘制的画面比较，逐对象和实例化两条路径像素完全一致。

材质更新用两个三角形共享同一材质。检查颜色同步变化、lit/unlit 切换及原始参数不被回写；连续 64 次更新期间拦截 GPU 对象创建，两种路径均没有新增 program、buffer 或 VAO。随后主动丢失并恢复上下文，验证保留已更新颜色，再在第二次丢失期间修改材质，恢复后显示新颜色。底层 Rust 接口另检查无效 ID、长度、NaN 和越界值不会覆盖原材质；TS 同时检查稀疏数组与 dispose 后调用。

几何更新用红、绿两个对象在不同材质组引用同一几何体，另有独立的蓝色标记。顶点从视锥外移入后，两组一起变为可见；独立组的包围体与像素保留。连续 64 次更新没有新增 program、buffer 或 VAO；退化为点的三角形不产生像素，恢复顶点后可继续绘制。两次上下文丢失分别检查既有更新和丢失期间更新，外部顶点、索引及批次数组修改不会改变恢复结果。包围球单测还覆盖 f32 球心舍入、半径向外舍入和半径溢出拒绝。

拓扑替换将同一共享几何从视锥外的三角形换成视锥内的四边形，可见对象由 1 个变为 3 个、三角形由 1 个变为 5 个。32 次交替扩容/缩容后存活 GPU 对象数保持不变，未重建 program；最终 dispose 后对象全部释放。分别注入 VAO、顶点句柄、索引句柄、顶点存储和索引存储分配失败，原画面、三角形数与存活资源均保持不变。上下文恢复与丢失期间替换另做像素和统计检查。故障注入验证清理逻辑，不等同于真实驱动显存耗尽测试。

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

单独检查镜像路径：

```bash
npm run build:wasm
npm run test:e2e -- tests/browser/mirrors.spec.ts
```

单独检查非原点包围球：

```bash
npm run build:wasm
npm run test:e2e -- tests/browser/bounds.spec.ts
```

单独检查剪切剔除：

```bash
cargo test --locked queue::tests
npm run build:wasm
npm run test:e2e -- tests/browser/culling.spec.ts
```

单独检查场景失效与恢复：

```bash
npm run build:wasm
npm run test:e2e -- tests/browser/invalid-scene.spec.ts
```

单独检查光照数值边界：

```bash
npm run build:wasm
npm run test:e2e -- tests/browser/lighting.spec.ts
```

单独检查 GPU 查询与样本完整性：

```bash
npx tsx --test tests/gpu-timer.test.ts
npm run test:e2e -- tests/browser/gpu-sampling.spec.ts
```

单独检查矩阵抵消：

```bash
cargo test --locked multiplication
npm run build:wasm
npm run test:e2e -- tests/browser/cancellation.spec.ts
```

单独检查点投影：

```bash
cargo test --locked point_projection
npm run build:wasm
npm run test:e2e -- tests/browser/projection.spec.ts
```

单独检查材质更新：

```bash
npm run build:wasm
npm run test:e2e -- tests/browser/materials.spec.ts
```

单独检查几何更新：

```bash
npx tsx --test tests/geometry-bounds.test.ts
npm run build:wasm
npm run test:e2e -- tests/browser/geometry-updates.spec.ts
```

单独检查拓扑替换：

```bash
npm run build:wasm
npm run test:e2e -- tests/browser/topology.spec.ts
```

截图、trace 和测试报告保存在 `test-results/`，CI 会上传 artifact，该目录不提交到仓库。

## 验证边界

本地环境为 macOS / Apple Silicon、Rust 1.99.0、Node.js 20.20.2 和 Chromium 156；CI 使用 Linux / Node.js 22。Firefox、Safari 和驱动永久故障尚未实际验收。

Headless Chromium 可能使用软件渲染。自动化跑分用于验证采样流程，不代表真实显卡性能；模拟 GPU 查询测试也不等同于硬件计时验证。
