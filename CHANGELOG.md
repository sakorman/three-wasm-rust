# 更新记录

按日期倒序记录功能、修复与验证结果。详细测试范围见 [测试说明](docs/verification.md)。

## 2026-10-30 · 高斯深度与剔除隔离

- 独立高斯 pass 现关闭深度测试、深度写入和面剔除，按准备好的顺序合成；正常返回与绘制抛错后均恢复调用方开关和写掩码。此前继承 Mesh 状态会使高斯缺失，并可能覆盖目标深度。
- 32×32 真实 WebGL2 回归覆盖全屏/瓦片两条路径及七组深度、写掩码、剔除和绕序设置。修复前六组出现 1,443–1,605 个 RGBA 通道差异，其中 `LESS` 加深度写入改动 535 个深度像素；修复后颜色逐字节一致，深度探针未发现改动。提交后注入异常再重试也保持状态和深度。
- 验证：10 项相关 Chromium 回归、strict 类型检查、原生/wasm32 Clippy 和生产构建通过。复现命令为 `npm run test:e2e -- tests/browser/gaussian-depth-state.spec.ts`，JSON 保存颜色差异、深度探针和调用前后状态。
- 范围：当前记录没有目标深度，本接口是屏幕空间合成，不能据此实现 Mesh 与高斯的互相遮挡。framebuffer、模板测试、颜色写入和采样状态仍由调用方配置；未测量性能收益。参考 [WebGL 光栅状态](https://registry.khronos.org/webgl/specs/latest/1.0/#5.14.3) 与 [SparkRenderer 深度选项](https://sparkjs.dev/docs/spark-renderer/#optional-parameters)，未引入外部代码。

## 2026-10-30 · 高斯着色器失败清理

- 修复片元着色器分配或编译失败后未删除已编译顶点着色器的问题。程序创建流程现统一释放临时 shader，失败时删除已创建的 program；构造和上下文恢复共用该清理路径。
- 真实 WebGL2 回归中，连续三次失败此前留下 1、2、3 个未主动删除的 shader，回收依赖 GC；修复后每次均为零。覆盖片元分配、编译、程序分配和链接四种失败，恢复失败时拒绝绘制，下一次恢复后像素与原图逐字节一致。
- 验证：12 项相关 Chromium 测试、strict 类型检查、原生/wasm32 Clippy 与生产构建通过。复现命令为 `npm run test:e2e -- tests/browser/gaussian-program-lifecycle.spec.ts`，JSON 报告记录失败后的存活句柄和恢复前后像素差异。
- 范围：验证显式资源清理，不测量驱动内部内存或实际故障发生率；恢复失败时保留上传数据，供后续恢复使用。参考 [WebGL shader/program 生命周期](https://registry.khronos.org/webgl/specs/latest/1.0/#5.14.9) 与 [SparkRenderer 资源释放](https://sparkjs.dev/docs/spark-renderer/#dispose)，未引入外部代码。

## 2026-10-30 · 高斯混合方程隔离

- 修复高斯绘制继承前序 RGB/alpha 混合方程的问题：此前只设置混合因子，减法或 MIN/MAX 状态会改变颜色与透明度。全屏和瓦片路径现显式使用 `FUNC_ADD`，正常返回和异常退出均恢复调用方的独立方程。
- 32×32 重叠红绿高斯回归覆盖五组混合方程；修复前两条路径各有 535–1,605 个 RGBA 通道偏离标准合成，修复后全部逐字节一致。中心颜色另与解析预乘值对照，注入绘制异常后状态恢复且重试结果一致。
- 验证：8 项相关 Chromium 测试、strict 类型检查、原生/wasm32 Clippy 和生产构建通过。复现命令为 `npm run test:e2e -- tests/browser/gaussian-blending.spec.ts`，报告保存在 `test-results/**/gaussian-blending.json`。
- 范围：本项修复混合状态，深度、剔除和目标 framebuffer 仍由调用方配置，未测量性能收益。参考 [WebGL 混合方程规范](https://registry.khronos.org/webgl/specs/latest/1.0/#5.14.3) 与 [SparkRenderer 预乘颜色累积接口](https://sparkjs.dev/docs/spark-renderer/)，未引入外部代码。

## 2026-10-30 · 高斯上传资源快照

- 新增 `GaussianUploadBuffers.resourceStats()` 与 `GaussianRasterRenderer.resourceStats()`：分别报告交错记录、原始 ID、瓦片引用副本的 CPU 字节数，以及当前可用 VBO 容量。此前 `snapshot()` 只在资源就绪时提供句柄和容量，无法区分恢复所需的 CPU 副本与可用 GPU 缓冲。
- 上下文丢失、静默分配失败、主动卸载和释放后 GPU 数值归零；丢失期间保留 CPU 副本，恢复后按最新数据重传。缩减上传仍可保留既有 VBO 容量，瓦片移除后其容量归零。
- 验证：模拟 WebGL 覆盖更新、失败、恢复、卸载与重载的精确字节数；真实 WebGL2 覆盖容量复用、上下文丢失/恢复和绘制器重载。完整测试 297 项通过（90 Rust、105 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：快照不包含 PLY 原文、program、VAO、JavaScript/驱动开销或实际显存，不能用于推断 GPU 时间或性能。参考 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) 与 [`gsplat` rasterization](https://docs.gsplat.studio/main/apis/rasterization.html)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-30 · 引擎 CPU 资源快照

- 新增 `Engine.cpuResourceStats()`：准确汇总引擎为恢复保留的顶点、索引、批次和动画 TypedArray 字节数，并返回几何体与材质条数。此前只能读取 GPU 缓冲快照，无法区分引擎自身保留的 CPU 数组。
- 构造后引擎只保存重建所需的独立副本，不再保留完整输入 `EngineScene`；上下文丢失、恢复失败和恢复成功期间 CPU 快照保持，`dispose()` 同时释放这些副本并返回零值。
- 验证：真实 WebGL2 覆盖逐对象/实例化两种路径的拓扑扩缩容、失败回滚、丢失期间编辑、重建失败/重试和释放；完整测试 297 项通过（90 Rust、105 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：统计只涵盖 Engine 持有 TypedArray 的 `byteLength`，不包含 JS 对象/字符串、WASM 堆、浏览器 GC、调用方仍持有的输入、驱动或显存；不能据此推断加载峰值、帧率或 GPU 时间。参考 [WebGL 上下文丢失与恢复](https://registry.khronos.org/webgl/specs/latest/1.0/#5.15.2) 与 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-30 · 高斯视图主动卸载

- 新增 `GaussianUploadBuffers.clear()` 与 `GaussianRasterRenderer.clear()`：可在保留渲染器、上下文订阅、program 和 VAO 的前提下释放当前高斯视图的 CPU 副本与 VBO。此前只有永久 `dispose()` 能释放上传数据，视图会持续占用资源，且恢复时仍可能重传旧数据。
- 卸载后快照、瓦片布局和记录数均为空，`draw()` 明确拒绝没有上传数据的调用；WebGL 上下文恢复不再重建已卸载视图，后续 `update()` 可在同一对象上重新上传并绘制。
- 验证：模拟上下文覆盖 VBO 删除、恢复不重传和重新上传；真实 WebGL2 覆盖卸载后的拒绝绘制与重新上传前后像素一致。完整测试 297 项通过（90 Rust、105 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：仅管理当前高斯上传记录和 VBO，保留 program、VAO 及上下文订阅；尚未连接场景级资产调度、自动卸载策略或显存测量，不代表帧率或 GPU 时间收益。参考 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) 与 [`gsplat` rasterization](https://docs.gsplat.studio/main/apis/rasterization.html)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-29 · PLY 到 Three 相机视图

- 新增 `prepareGaussianPlyForThreeCamera()`：以一次调用衔接世界相机位置反解、模型空间 SH 颜色、正 z 相机空间中心/协方差变换，以及筛选、投影、排序和分箱。此前调用方需要手工串联四个步骤，容易把世界坐标用于 SH，或遗漏将动态颜色传入准备阶段。
- 输入使用复制后的 Three.js 模型矩阵、`matrixWorldInverse` 与世界相机位置；输出为独立紧凑视图，不改写训练 PLY 源数据。非法矩阵、相机位置或光栅参数仍沿用各阶段的明确拒绝。
- 验证：Node 将单次入口与分步的 Three.js 参考逐项比较，并覆盖错误位置长度；浏览器从训练 PLY 经该入口进入上传，确认视角颜色与远近顺序。完整测试 296 项通过（90 Rust、104 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：不自动订阅 Three.js 模型或相机变换，调用方变更后须重新准备；尚未接入首页 Mesh 场景或 GPU SH 着色，不代表真实模型加载耗时、画质或帧率。参考 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)、[`gsplat` rasterization](https://docs.gsplat.studio/main/apis/rasterization.html) 与 [Three.js Camera.matrixWorldInverse](https://threejs.org/docs/#api/en/cameras/Camera.matrixWorldInverse)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-29 · SH 模型空间相机位置

- 新增 Rust/WASM `gaussian_model_camera_position()` 与 `modelCameraPositionFromThreeWorld()`：通过模型矩阵的逆仿射变换，将世界相机位置转换为 PLY 模型空间观察点。此前调用方需自行求逆，直接传世界坐标会在模型含平移、旋转或缩放时得到错误的 SH 方向。
- 转换校验输入为有限、仿射且线性部分可逆；TypeScript 助手只接收矩阵和位置副本，不引入 Three.js 依赖。浏览器 SH 上传链路现显式使用该模型空间位置。
- 验证：Rust 覆盖旋转、非均匀缩放、平移及非法矩阵；Node 与 Three.js `Matrix4.invert()` 的位置结果比较；浏览器覆盖 SH 颜色到准备和上传。完整测试 295 项通过（90 Rust、103 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：不自动订阅模型或相机变换，只接受仿射模型矩阵；SH 仍在 CPU/WASM 侧求值，尚未进入 GPU shader 或主页面渲染循环。参考 [Three.js Matrix4.invert](https://threejs.org/docs/#api/en/math/Matrix4.invert)、[3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) 与 [`gsplat` SH 工具说明](https://docs.gsplat.studio/main/apis/utils)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-29 · 高斯视角 SH 颜色

- `parseGaussianSplatPly()` 现识别完整连续的 1、2、3 阶 `f_rest_*` 组，并以基函数主序 RGB 三元组保留原始系数。此前只还原 DC 颜色，训练出的视角相关颜色会被忽略；不完整或未知组仍按原行为跳过。
- 新增 Rust/WASM `gaussian_sh_colors()` 与 `evaluateGaussianPlyShColors()`：使用与模型空间中心一致的相机位置求 0–3 阶实球谐，输出可直接传入准备路径的非负线性 RGB。输入长度、系数有限性、相机位置和相机与高斯中心重合均会被拒绝。
- 验证：Rust 覆盖 1 阶方向项、3 阶末项和非法批次；Node 覆盖 PLY 系数布局与模型空间求值；浏览器覆盖 SH 颜色进入准备和上传。完整测试 294 项通过（89 Rust、103 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：SH 仍在 CPU/WASM 侧独立求值，不自动同步 Three.js 相机、不在 GPU 着色器内动态计算，也不支持 3 阶以上、色彩管理或曝光。参考 [原始 PLY 与系数布局](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/scene/gaussian_model.py)、[`gsplat` SH 工具说明](https://docs.gsplat.studio/main/apis/utils) 与 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-29 · 高斯相机组合校验

- 新增 Rust/WASM `gaussian_compose_three_camera()`：将模型矩阵和 Three.js 负 z 视图矩阵在一次受约束调用中组合为正 z 相机矩阵。此前 TypeScript 助手连续调用通用矩阵乘法，错误矩阵可能延后到属性变换阶段才被拒绝。
- 模型、视图与组合结果现在都会校验为有限、仿射且线性部分可逆；TypeScript 助手改为委托生成的 WASM 绑定，接口仍不依赖 Three.js。
- 验证：新增 Rust 组合与拒绝路径测试；完整测试 291 项通过（87 Rust、102 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：不自动订阅模型或相机变换，不接受投影矩阵，尚未将真实高斯资产接入主场景。参考 [Three.js Camera.matrixWorldInverse](https://threejs.org/docs/#api/en/cameras/Camera.matrixWorldInverse)、[3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) 与 [`gsplat` rasterization](https://docs.gsplat.studio/main/apis/rasterization.html)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-29 · Three.js 高斯视图组合

- 新增 `composeThreeModelToPositiveZCamera()`：将 `model.matrixWorld` 和 `camera.matrixWorldInverse` 的列主序副本组合为 `diag(1, 1, -1, 1) × view × model`。此前调用方需手工插入 z 翻转，模型变换与视图矩阵的乘法顺序容易出错。
- 助手不导入 Three.js，仍由 Rust/WASM 完成矩阵乘法和 f32 溢出校验；返回矩阵可直接交给 PLY 高斯的相机空间变换。相机或模型变动后由调用方重新组合。
- 验证：Node 将带旋转、非均匀缩放的 Three.js 模型与相机参考逐项比较，并确认模型原点转换到正 z；浏览器 PLY→准备→上传链路核对深度排序和 DC 颜色。完整测试 290 项通过（86 Rust、102 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：不自动订阅 Three.js 变换，不接受透视矩阵进入协方差变换，尚未将真实高斯资产接入主场景。参考 [Three.js Camera.matrixWorldInverse](https://threejs.org/docs/#api/en/cameras/Camera.matrixWorldInverse) 与 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-29 · 高斯相机空间变换

- 新增 Rust/WASM `gaussian_transform_camera_space()` 和 TypeScript `transformGaussianPlyToCameraSpace()`：训练 PLY 的模型空间中心现可按列主序仿射矩阵转换到光栅准备所需的正 z 相机空间，协方差同步按 `R × Σ × Rᵀ` 变换。此前调用方只能自行改写中心与协方差，容易遗漏旋转或缩放。
- 变换会返回独立的中心、协方差、不透明度和颜色数组；透视矩阵、奇异线性部分、非有限中心和非正定协方差会在准备前被拒绝。Three.js 的负 z 相机视图仍需调用方显式预乘 z 翻转矩阵。
- 验证：新增中心/协方差解析变换与拒绝路径 Rust 测试；Node 覆盖 PLY 解码、属性副本隔离和准备衔接；浏览器覆盖转换后的深度进入上传。完整测试 289 项通过（86 Rust、101 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：不接受投影矩阵，不自动读取 Three.js 相机或处理动画变换；高阶 SH、真实模型流式加载和主场景接入尚未实现。公式参考 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) 与 [`gsplat` rasterization](https://docs.gsplat.studio/main/apis/rasterization.html)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-28 · 训练 PLY 输入

- 新增 `parseGaussianSplatPly()`：接收原始 3DGS 训练代码写出的二进制小端 PLY，输出独立的模型空间中心、协方差、激活后不透明度和线性 RGB。此前光栅准备只能接收调用方手工提供的数组。
- 新增 Rust/WASM 的 log-scale 与 `[w, x, y, z]` 四元数协方差激活；输出写回 f32 后检查正定性。0 阶 SH 颜色会还原为 RGB 并截断负通道，字段顺序可变的 PLY 仍按名称读取。
- Node 覆盖乱序字段、未知标量、截断/格式/字段/旋转拒绝及准备衔接；浏览器回归覆盖 PLY 到准备和上传的 DC 颜色保持。
- 验证：287 项测试通过（84 Rust、101 Node、102 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：仅支持原始二进制小端 f32 顶点布局，只使用 0 阶 SH；不支持高阶视角相关颜色、坐标变换、流式加载、色彩管理、曝光或色调映射。参考 [原始 PLY 属性与激活](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/scene/gaussian_model.py) 与 [SH 常数](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/utils/sh_utils.py)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-28 · 高斯线性 RGB 合成

- `prepareGaussianRaster()` 现在接收可选的非负线性 RGB 并随紧凑深度顺序重排；缺省输入写入白色。此前独立 pass 只输出灰度 alpha，颜色无法进入高斯记录。
- 上传记录扩展为 15-f32（60 字节），`GaussianRasterRenderer` 读取 RGB 属性并以预乘 alpha 合成。颜色、上传缓冲缩容和上下文恢复均按新布局校验。
- Node 回归覆盖深度重排、白色缺省、畸形与负色拒绝；WebGL2 回归确认红色和青色记录在各自中心保留正确颜色分量。
- 验证：282 项测试通过（82 Rust、99 Node、101 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：当前只支持调用方提供的线性 RGB，不加载高斯资产，不计算视角相关 SH、色彩空间转换、曝光或色调映射；该功能不代表真实模型的画质、GPU 时间或帧率。参考 [`gsplat` rendering`](https://github.com/nerfstudio-project/gsplat/blob/main/gsplat/rendering.py) 与 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-28 · 高斯瓦片连续记录分批

- `GaussianUploadBuffers` 新增连续局部 ID 段迭代，`drawTiles()` 对每段执行一次实例化提交。此前每条瓦片引用都会单独提交；现在仅合并相邻记录，跳号或逆序会保留独立段和原有混合顺序。
- 16 像素网格的 52 条引用仍与全屏紧凑路径逐字节一致，浏览器回归确认实际提交数小于引用数、scissor 状态和区域不变；Node 回归覆盖连续段与非连续 ID 拆段。
- 验证：280 项测试通过（82 Rust、98 Node、100 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：该路径仍在 CPU 侧迭代，不能对任意稀疏 ID 批量提交，未接入颜色/SH、纹理或主页面，也未测量 GPU 时间、帧率或端到端性能。参考 [`gsplat` rasterization](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) 与 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-28 · 高斯瓦片绘制路径

- `GaussianUploadBuffers` 新增只读瓦片元数据与局部 ID 迭代；外部数组在 `update()` 后改写不会影响瓦片调度。此前上传缓冲虽保存了瓦片引用，独立光栅 pass 并未消费它们。
- `GaussianRasterRenderer.drawTiles()` 按行优先瓦片—局部 ID 顺序设置 scissor，并校验瓦片网格与绘制尺寸。每条引用配置其交错记录后单实例提交，调用结束恢复调用方 scissor 状态和区域。
- 16 像素网格的 52 条引用与全屏紧凑路径逐字节一致；单元测试确认元数据与局部 ID 顺序，浏览器测试确认像素和非默认 scissor 状态。
- 验证：279 项测试通过（82 Rust、97 Node、100 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：当前实现每条引用一次提交，尚未实现基于实例 ID 的批量瓦片提交、颜色/SH、纹理或主页面接入；该正确性路径不代表 GPU 时间、帧率、显存或 draw call 收益。参考 [`gsplat` rasterization](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) 与 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-28 · 独立高斯光栅 pass

- 新增 `GaussianRasterRenderer`：固定交错上传记录现在可由独立 WebGL2 pass 直接绘制。此前只有 VBO 数据准备和手写测试着色器，没有可复用的绘制器。
- 绘制器读取中心、范围、逆协方差、不透明度和裁切系数，以预乘 alpha 执行 CDF 裁切与源顺序合成；上下文恢复时先重传上传缓冲，再新建 shader/VAO。调用结束后恢复 program、VAO、数组缓冲、viewport 和混合状态。
- 真实 WebGL2 回归中，裁切相对未裁切有 23,264 个不同 RGBA 通道；恢复前后裁切图逐字节一致，并覆盖调用方混合状态恢复。
- 验证：277 项测试通过（82 Rust、96 Node、99 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：当前 pass 不读取瓦片引用、颜色、球谐、纹理或深度/透明度策略，未接入首页 Mesh 场景；该合成回归不代表 GPU 时间、帧率、显存、真实模型画质或完整 3DGS。参考 [`gsplat` rasterization](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) 与 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-28 · 高斯上传缓冲恢复

- 新增 `GaussianUploadBuffers`：高斯上传记录现在会由资源层保存独立 CPU 副本，并维护交错数据和瓦片两类 WebGL2 缓冲。此前调用方需直接创建缓冲，且上下文恢复后没有可重传的资源状态。
- 容量足够的记录更新改为 `bufferSubData`，缩减记录不会收缩已有 VBO；移除瓦片时释放其缓冲。上下文丢失时不再暴露旧句柄，恢复后使用最新副本重建并重传。
- 上传后核验实际缓冲容量，静默分配失败会清理句柄并允许后续更新重试。浏览器回归覆盖 3 条记录缩减到 2 条时复用 144 字节 VBO、真实 `WEBGL_lose_context`、恢复前写入和恢复后读回；单元测试覆盖副本隔离、瓦片释放、畸形上传和分配失败重试。
- 验证：276 项测试通过（82 Rust、96 Node、98 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：该资源层尚未连接主高斯绘制器，不管理 VAO、shader、纹理或实际 draw call；容量复用和恢复测试不代表 GPU 时间、帧率、显存收益或完整场景恢复时间。参考 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/) 与 [`gsplat` rasterization API](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-27 · 高斯上传数据打包

- 新增 `packGaussianRasterUpload()` 与 `GAUSSIAN_RASTER_UPLOAD_STRIDE`：将紧凑视图转换为每项 12-f32 的交错记录，包含屏幕中心、范围、逆协方差、不透明度、裁切系数和启用位。此前准备结果仍是分散数组；现在可直接按固定属性偏移上传实例缓冲。
- 复制源 ID 和瓦片偏移—引用缓冲，后者始终引用紧凑记录；拒绝数组长度不匹配、重复源 ID、非正定协方差、无效瓦片偏移及溢出 f32 的逆矩阵。
- WebGL2 回归将三项记录写入 144 字节 VBO，以一次实例化绘制读取所有属性；瓦片缓冲为 980 字节、52 条引用，裁切相对未裁切有 23,264 个不同通道，未出现 WebGL 错误。
- 验证：273 项测试通过（82 Rust、94 Node、97 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：该接口只生成 CPU 侧上传数据，不创建、复用或恢复 GPU 资源，也未接入主渲染器、SH 或真实高斯资产。参考 [`gsplat` rasterization API](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) 与 [XClipGS](https://arxiv.org/abs/2608.07760)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-27 · 高斯视图准备链路

- 新增 `prepareGaussianRaster()`：将不透明度/支持范围筛选、投影、可选滤波、范围、视口筛选与深度排序收敛为一份紧凑相机视图数据，可选生成半空间裁切系数和瓦片分箱。此前调用方必须自行维护每阶段的局部索引与源 ID；现在 `originalIds` 和瓦片局部 ID 的语义固定并保持对齐。
- 四项输入的回归中，支持范围保留四项、视口移除一项离屏候选，输出源 ID 为 `[2, 1, 0]`；16 像素瓦片有 52 条局部引用。WebGL2 将准备数据送入 CDF 片元路径，裁切相对未裁切有 23,264 个不同通道、1,976 个可见像素。
- 验证：270 项测试通过（82 Rust、92 Node、96 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：接口不创建 GPU 资源，未加载高斯资产、未实现 SH 或主渲染器上传；中心深度排序与局部瓦片引用不解决逐像素遮挡。参考 [`gsplat` rasterization API](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) 与 [XClipGS](https://arxiv.org/abs/2608.07760)，未使用其代码、模型、实验数据或性能结论。

## 2026-10-27 · 高斯半空间裁切系数

- 新增 `gaussian_halfspace_clip_coefficients()`：以相机空间半空间和投影 Jacobian 生成每个高斯的 `[kx, ky, h]`，片元可用条件高斯 CDF 调整 alpha。此前跨近平面的候选只能保留或丢弃，不能表达单个高斯在平面两侧的连续覆盖变化。
- 平面法线与偏移一起归一化；`[0, 0, -1], -near` 可表达 `z ≥ near`。接口与投影一致地校验 f32 屏幕协方差，并拒绝无效焦距、平面、中心或协方差；退化条件方差以 `1e-8` 保持系数有限。
- 独立 Node 公式参考核对 4,097 项协方差。256×192 WebGL2 斜切面回归中，左右 alpha 为 15、0，中心 CDF 因子为 0.4723179，1,166 个像素可见；267 项测试通过（82 Rust、90 Node、95 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。
- 限制：当前只准备裁切系数，主渲染器尚未上传系数或执行 CDF；结果只适用于局部仿射 EWA 近似，不代表完整场景的近裁剪、混合质量、GPU 时间或帧率。参考 [XClipGS](https://arxiv.org/abs/2608.07760)；未使用其代码、模型、实验数据或性能结论。

## 2026-10-27 · 高斯瓦片内稳定深度排序

- 新增 `gaussian_tile_depth_order()`：保留分箱偏移表，对每个瓦片内的高斯 ID 按中心深度远到近稳定排序。此前分箱只保留调用方顺序；现在可直接为透明混合生成独立的瓦片内顺序，同深度及正负零保持输入相对顺序。
- 接口完整校验有限深度、偏移从零开始且单调、末项与 ID 数一致、索引范围及同一瓦片内重复 ID；同一 ID 在不同瓦片仍可复用。失败时不返回部分结果。
- 4,097 项的独立 JavaScript 稳定排序参考与 WASM 输出一致。256×192 WebGL2 用例中，8 个重叠候选生成 23 条瓦片引用；瓦片内排序与全局远到近参考逐通道一致，故意跳过局部排序有 1,651 个不同通道。
- 限制：排序仅使用中心深度，在 CPU/WASM 完成；未实现 GPU 键值排序、逐像素遮挡或真实模型帧率测量。参考 [`gsplat` 瓦片排序说明](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) 与 [WebGPU Gaussian Splatting](https://github.com/lu-m-dev/WebGPU-gaussian-splatting)，未使用其代码、模型或性能数据。
- 验证：262 项测试通过（80 Rust、88 Node、94 Chromium），strict、原生/wasm32 Clippy 与生产构建通过。

## 2026-10-27 · 高斯屏幕瓦片分箱

- 新增 `gaussian_tile_bins()`：将筛选后的二维高斯范围编入行优先瓦片，返回偏移表和原始高斯 ID，保留候选顺序及与瓦片边界相交的项；此前调用方只能逐项全屏遍历候选。
- 4,097 项范围与独立行优先参考一致。256×192 WebGL 用例中，8 个候选生成 25 条瓦片引用；按瓦片 scissor 绘制与逐项全屏绘制逐通道一致，均有 4,387 个可见像素。
- 单次上限为 1,000,000 个瓦片和 4,000,000 条引用，超出整批拒绝。分箱不排序、不提交 GPU 命令，也不代表帧率提升；该用例的瓦片路径有 25 次绘制提交，仅用于验证覆盖。
- 参考 [gsplat tile_size](https://docs.gsplat.studio/main/apis/rasterization.html) 与 [TileGS](https://arxiv.org/abs/2609.03613)，未采用其 GPU 分桶、局部深度策略或性能数据。
- 验证：259 项测试通过（78 Rust、87 Node、94 Chromium），strict、原生/wasm32 Clippy 与生产构建通过；覆盖边界相交、整批拒绝、引用上限、独立分箱差分和 WebGL 像素对照。

## 2026-10-27 · 屏幕低通滤波与不透明度补偿

- 新增 `gaussian_filter_screen_covariances()`：为投影二维协方差加入各向同性滤波方差，并按返回 f32 协方差的行列式比补偿峰值不透明度。此前下游只能使用未滤波协方差；现在可在范围、视口筛选和光栅前使用同一份滤波后数据。
- 4,097 组正定 f32 协方差与 f64 公式参考一致，零滤波按位保留输入。512×512 单高斯 WebGL 回归中，alpha 字节和从 12,166 变为 12,152，解析连续积分相对差小于 `2e-6`；该结果不等同于真实模型的画质或帧率。
- 连续积分补偿不保证 alpha 混合、阈值丢弃、多个高斯重叠或不同分辨率下的像素亮度、PSNR/SSIM 一致；未接入三维平滑、真实近平面裁切或 SH 着色。公式参考 [gsplat antialiased rasterization](https://docs.gsplat.studio/main/apis/rasterization.html) 与 [Mip-Splatting（CVPR 2024）](https://openaccess.thecvf.com/content/CVPR2024/html/Yu_Mip-Splatting_Alias-free_3D_Gaussian_Splatting_CVPR_2024_paper.html)。
- 验证：253 项测试通过（76 Rust、84 Node、93 Chromium），strict、原生/wasm32 Clippy 和生产构建通过；覆盖输出 f32 对齐、能量补偿、非法整批、范围衔接及实际 WebGL 像素读取。

## 2026-10-26 · 保留跨近平面的高斯支持范围

- 新增 `gaussian_clip_depth_support_indices()`：根据三维协方差的 z 支持范围与 alpha 阈值筛选近远平面候选，保留跨近平面、相切项、原始索引和候选顺序；f64 端点向外扩展以避免相切项因舍入漏筛。
- 4,097 组有限 f32 协方差与 f64 公式参考一致。浏览器用例中，4 个不透明候选按中心筛选仅余 1 个，支持范围筛选保留 3 个；3 个候选的画面有 4,303 个可见像素，错误地丢弃跨平面项会产生 14,627 个不同 RGBA 通道。
- 该接口只决定候选，不裁切椭球几何，也不解决近平面附近的透视近似或完整 3DGS 光栅化；没有真实模型性能或画质结论。参考 [gsplat 近远平面参数](https://docs.gsplat.studio/main/apis/rasterization.html)、[Gaussian Point Splatting](https://doi.org/10.1145/3811272) 和[项目实现](https://github.com/JorisAR/gaussian-point-splatting)。
- 验证：247 项测试通过（74 Rust、81 Node、92 Chromium），strict、原生/wasm32 Clippy 和生产构建通过；覆盖交叉近远面、阈值边界、正定协方差、非法整批和像素负对照。

## 2026-10-26 · 剔除完全离屏的高斯范围

- 新增 `gaussian_viewport_indices()`，按屏幕中心与半宽/半高筛选视口相交范围，保留相切项、原始索引和候选顺序；零面积范围排除，端点采用 f64 向外舍入。
- 合成 WebGL 用例的绘制提交从 28 次降为 24 次，3,635 个可见像素与未筛选参考 RGBA 一致，f32 和 binary16 两条路径均通过。只检查中心的负对照会漏掉边缘像素，产生 2,161 个不同通道；另用精确整数参考核对 4,097 个随机范围。
- 输入范围应覆盖实际绘制几何，半精度路径按解包后的范围筛选；接口不做遮挡或精确椭圆裁剪，未宣称真实模型 FPS 提升。设计参考 [WebSplatter 预处理](https://arxiv.org/html/2602.03207v1#S3.SS2)，[研究说明](docs/gaussian-rendering.md)同步记录最新的 SOG 环境加载预算选项。
- 验证：241 项测试通过（72 Rust、78 Node、91 Chromium），strict、原生/wasm32 Clippy 和生产构建通过；覆盖极端端点、次正规数、空候选、零面积及非法批次。

## 2026-10-26 · 投影前筛选近远深度候选

- 新增 `gaussian_clip_depth_indices()`，按 `near ≤ depth ≤ far` 筛选高斯中心，保留原始索引与候选顺序。相机后方、零深度及范围外中心可在投影前移除，近远边界项保留，支持无限远上界。
- 65,537 项输入与 JS 筛选/排序对照一致。浏览器用例将 8 项中的 7 个不透明度候选缩为 3 个深度候选，避免后方中心中断投影；后续绘制有 2,074 个可见像素，与未压缩范围参考 RGBA 一致。
- 此处按中心筛选，不裁切跨平面的椭球、不做视口剔除，未给出真实模型帧率收益。参考 [gsplat 近远平面参数](https://docs.gsplat.studio/main/apis/rasterization.html) 与 [WebSplatter 预处理](https://arxiv.org/html/2602.03207v1#S3.SS2)。
- 验证：233 项测试通过（69 Rust、75 Node、89 Chromium），strict、原生/wasm32 Clippy 和生产构建通过；覆盖相邻 f32、边界相等、次正规深度、空候选及非法批次。

## 2026-10-26 · 拒绝舍入退化的高斯投影

- 投影在转换为 f32 后检查二维协方差正定性。远距离下溢和离轴舍入原先会返回零矩阵、奇异或非正定矩阵，直到计算范围时才失败；现在直接报出问题高斯索引，整批不返回部分结果。
- 保留最小正 f32 方差，不增加固定半径。128 组各向异性输入与透视映射数值差分对照；浏览器验证拒绝后的正常调用，以及投影、范围、排序、打包到透明绘制的衔接。
- 参考 [gsplat 的投影与滤波参数](https://docs.gsplat.studio/main/apis/rasterization.html)、[Mip-Splatting](https://niujinshuchong.github.io/mip-splatting/)。本改动只约束数值输出，未加入抗锯齿滤波、不透明度补偿或真实模型帧率优化。
- 验证：227 项测试通过（67 Rust、72 Node、88 Chromium），strict、原生/wasm32 Clippy 和生产构建通过。衔接用例有 3,464 个可见像素，RGBA 与未压缩参考一致。

## 2026-10-25 · 接入三维高斯投影内核

- 新增 `gaussian_project_covariances()`：将相机空间三维协方差按透视 Jacobian 投影为像素空间二维协方差，同时返回像素中心和深度，结果可直接接入范围收紧、排序与 binary16 打包。
- 使用 f64 完成协方差乘法，验证交叉项、正定性、相机前方深度和整批原子拒绝；Node 与 Chromium 均直接调用 WASM 结果。
- 参考 [`gsplat` 投影 API](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst)；当前仍未接入 PLY/其他高斯资产、SH 着色或完整 GPU 光栅化，宽视场/近裁剪面仍需精确椭球投影。
- 验证：221 项测试通过（65 Rust、69 Node、87 Chromium），strict、原生/wasm32 Clippy 和生产构建通过。

## 2026-10-25 · 保留压缩后的高斯边缘

- 修复 binary16 最近舍入缩小包围范围的问题：半宽约 2048.75 像素原先变为 2048，可能漏画边缘；现在向外取到 2050。极小正范围不再归零，真正的零支持仍保持为零。
- 遍历全部 31,744 个非负有限 binary16 编码及相邻区间；WebGL2 实际解包后，旋转/重叠椭圆、阈值边界、大范围边缘三组像素均与 f32 对照一致。大范围旧舍入负对照有 3 个 RGBA 通道不同，修复后为 0。
- 每项仍为 4 字节编码数据；向外舍入可能增加候选片元，不据此推断 GPU 带宽或帧率收益。范围压缩设计参考 [WebSplatter 预处理](https://arxiv.org/html/2602.03207v1#S3.SS2)，使用约定与复现方式见[高斯光栅化准备](docs/gaussian-rendering.md#轴数据压缩)。
- 验证：216 项测试通过（63 Rust、67 Node、86 Chromium），strict、原生/wasm32 Clippy 和生产构建通过。

## 2026-10-24 · 高斯轴数据压缩

- 新增 `gaussian_pack_half_extents()`，将屏幕半宽/半高按 binary16 打包为每个高斯一个 `u32`，后续 GPU 上传带宽从 8 字节降到 4 字节；输入顺序和零支持项保持不变。
- 覆盖 round-to-nearest-even、最大有限 binary16、次正规值、非法范围和奇数长度；Node 解包检查典型值误差，未宣称真实模型画质等价。
- 参考 WebSplatter 将投影椭圆轴压为 16-bit 后传入光栅阶段：[论文预处理](https://arxiv.org/html/2602.03207v1#S3.SS2)。本接口只负责 CPU/WASM 打包，不包含 WebGPU 管线。
- 验证：211 项测试通过（62 Rust、66 Node、83 Chromium），strict、Clippy 和生产构建通过。

## 2026-10-24 · 高斯稳定深度排序

- 新增 `gaussian_depth_order()`，用四轮 8-bit 基数排序生成从远到近的候选索引；保留完整 f32 深度，相等深度和正负零保持输入顺序，拒绝重复及无效索引。
- 65,537 个深度的 WASM 结果与 JS 稳定排序一致；重叠高斯的透明混合与参考顺序逐像素一致，中心颜色符合解析结果。完整测试集为 207 项。
- 当前为 CPU/WASM 准备内核，不做视锥剔除或逐像素深度排序，尚无真实 3DGS 场景帧率收益结论。
- 参考：[WebSplatter 排序设计](https://arxiv.org/html/2602.03207v1#S3.SS3)。[研究说明](docs/gaussian-rendering.md)同步记录 [Gaussian-Splat-Lite 1.4.2](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/8576bb70d6f26884f7ca69ddf7f9b3b303e41484/CHANGELOG.md) 的随机渲染与去噪更新。

## 2026-10-24 · 稳定高斯索引压缩

- 新增 `gaussian_visible_indices()`，返回达到不透明度阈值的原始索引，保留输入顺序和等于阈值的项。后续步骤可直接遍历有效高斯，无需重复检查零支持范围。
- 合成 WebGL 回归将后续遍历项从 28 个压缩到 20 个，透明混合顺序及 RGBA 像素保持一致。筛选本身仍扫描全部输入；尚无真实场景总耗时或帧率收益结论。
- 覆盖空列表、阈值边界、非法输入、百万项限制和返回副本；验证及使用约定见[高斯光栅化准备](docs/gaussian-rendering.md)。
- 参考：[WebSplatter 预处理与排序](https://arxiv.org/html/2602.03207v1#S3)、[项目实现](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be)。本接口只进行不透明度筛选，不做深度排序。

## 2026-10-24 · 高斯支持范围收紧

- 新增 Rust/WASM `gaussian_screen_bounds()`，按不透明度与 alpha 阈值收紧屏幕四边形，跳过阈值以下高斯；保留等于阈值的中心样本。
- 28 个合成高斯的 WebGL 测试中，提交面积减少 **61.10%**，RGBA 像素完全一致。该指标是四边形面积，尚无真实模型 FPS 或画质提升结论；目前是 3DGS 准备内核，完整高斯管线待接入。
- 验证：196 项测试覆盖旋转椭圆、极端方差、阈值边界和非法输入；strict、Clippy 与生产构建通过。
- 参考：[WebSplatter 论文](https://arxiv.org/abs/2602.03207)、[对应实现](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be)。[研究说明](docs/gaussian-rendering.md)另记录 Gaussian-Splat-Lite 1.4.1 和 3DGEER 的适用边界。

## 2026-10-23 · 相机矩阵乘法精度

- 修复 TS 相机矩阵乘法逐项写入 f32，导致大数抵消后的偏移丢失或中间结果提前溢出的问题。现在使用 Number 累加，完成每个元素后再写入 f32；`1e8 + 0.5 - 1e8` 保留 0.5。
- 相机矩阵输入需为 16 个有限值，最终乘积超出 f32 范围时明确拒绝，输入数组不变。轨道相机组合结果与 Three.js 的一次最终舍入对齐。
- 验证：57 项 Node、15 项相机/对照/恢复浏览器回归、strict 和生产构建通过，包含抵消、溢出和两种绘制路径的像素对照；完整 CI 测试集为 187 项。
- 该修复只改善 CPU 矩阵组合。输入和输出仍为 f32，不恢复已丢失的精度，也不改变 GPU 顶点计算或深度精度。

## 2026-10-23 · 上下文恢复回调重入

- 修复恢复回调中调用 dispose 后，状态又被改为 ready 或 failed 的问题。现在 disposed 保持终止，回调后续返回或抛错均不会重新启用生命周期管理器。
- 阻止恢复回调同步重入造成的重复重建与重复就绪通知。重建失败会解除重入锁，未释放的实例仍可在下一次上下文周期恢复。
- 验证：54 项 Node、16 项上下文与资源浏览器回归、strict 和生产构建通过。新增四类回调释放/异常/嵌套事件回归，检查通知顺序及下一轮恢复；完整 CI 测试集为 182 项。
- 重建接口仍为同步回调，不负责取消调用方的异步任务；GPU 资源由所有者释放，`ContextLifecycle.dispose()` 本身只停止生命周期监听。

## 2026-10-23 · 三角形级射线查询

- 新增 Rust `ray_triangle_hits()`，对索引三角形返回交点参数和三个顶点的重心权重。此前只有包围盒候选，现在可排除包围盒空白区域，并由调用方选择最近表面。
- 支持双面或背面剔除、闭区间参数限制及表面起点；计算使用 f64，保留非归一化方向的参数含义。顶点和索引完整校验后求交，非法批次不返回部分结果。
- 验证：174 项测试通过，包含 256 三角形 Three.js 差分、25 组尺度组合、典型共享边/退化输入，以及两条绘制路径的遮挡和顶点更新；strict、原生/wasm32 Clippy 和生产构建通过。
- 查询仍逐三角形扫描，射线和顶点必须在同一坐标系；场景坐标转换、对象映射和 BVH 尚未接入。边界附近受浮点舍入影响，不保证任意近退化或共享边输入下的无缝命中。

## 2026-10-22 · 极小四元数归一化

- 修复有限非零四元数因长度小于 1e-12 被误判为零的问题。现在接受全部非零 f32 输入，包括 `[0, 0, 0, 2^-149]`，归一化后正确得到单位旋转；构造、单个/批量更新与矩阵合成接口行为一致。
- 保留全零、NaN 和 Infinity 的拒绝，批次中任一输入无效时不改写已有变换或准备好的队列。长度计算继续使用 f64。
- 验证：164 项测试通过，覆盖正负缩放、次正规数、36 组 Three.js 差分，以及两条绘制路径的编辑、失败保留和上下文恢复；strict、原生/wasm32 Clippy 和生产构建通过。
- 该修复不恢复输入转成 f32 前已丢失的分量；所有分量已下溢为零时仍拒绝，不承诺任意缩放后的舍入结果表示完全相同的旋转。

## 2026-10-22 · 射线包围盒候选

- 新增 Rust `ray_aabb_intervals()`，可直接使用世界 AABB 查询结果，批量返回射线进入/离开的参数区间；未命中为 `[-1, -1]`。此前只能读取包围范围，现在可进一步筛选射线候选。
- 支持范围裁剪、盒内起点、平行轴、负零方向分量和退化盒。f64 计算及保守舍入覆盖极小非零方向和极大参数，不将结果缩回 f32；输入无效时整批拒绝。
- 验证：157 项测试通过，包含 512 盒 Three.js 差分、72 组精确有理数区间检查及两条绘制路径的遮挡/移动验证；strict、原生/wasm32 Clippy 和生产构建通过。
- 方向不自动归一化，t 是射线参数，单位方向时才对应距离。结果保持输入顺序，属于包围盒粗筛，不代表精确命中模型表面；当前逐盒扫描，BVH 与三角形拾取尚未实现。

## 2026-10-22 · 世界 AABB 查询

- 新增 `SceneGraph.world_aabbs(nodes, local_bounds)`。此前只提供绘制用的包围球剔除，现在可批量读取局部盒在世界坐标中的轴对齐范围，供碰撞粗筛和空间索引使用。
- 支持层级、旋转、镜像、剪切和零尺寸盒；f64 区间累加与 f32 向外舍入避免范围缩小。失效场景、非法输入或无法表示的结果整批报错，原场景和已准备的队列不受查询影响。
- 验证：146 项测试通过，包含 512 节点 Three.js 差分、42 组 BigInt 精确角点检查、数值边界及两种绘制路径的像素覆盖；strict、原生/wasm32 Clippy 和生产构建通过。
- 查询要求先更新世界矩阵，输出为独立副本；它不自动替换现有剔除策略，也不执行射线或精确相交。范围相对于存储的 f32 矩阵保守，大数抵消时可能变宽，不提升输入或 GPU 投影精度。

## 2026-10-21 · GPU 资源统计

- 新增 `Engine.resourceStats()` 与 Rust `resource_stats()`，可读取缓冲、VAO、program 数量，以及顶点、索引和实例矩阵的分配字节数。此前只能从外部拦截 WebGL 调用检查，现在可直接在加载、编辑和释放后读取快照。
- 共享几何只计一次，实例矩阵按容量统计；拓扑替换成功更新字节数，失败保留原值。上下文丢失、重建失败和引擎释放后返回零 GPU 资源，恢复后反映最新数据。
- 验证：135 项测试通过。两条路径的统计与真实 WebGL 对象及缓冲容量对齐，覆盖 16 次扩缩容、失败回滚、恢复、零容量缓冲和快照生命周期；strict、原生/wasm32 Clippy 和生产构建通过。
- 统计不查询 GPU 缓冲存储，不包含驱动开销、帧缓冲、CPU/WASM 数据或替换时的瞬时峰值，不能当作实际显存占用。底层快照需要单独 free，TS 接口自动处理。

## 2026-10-21 · GPU 采样诊断

- JSON 新增 `gpuDiagnostics`，区分查询分配失败、队列达到上限、无效时长、等待结束仍未返回，以及扩展缺失和 disjoint。此前只能看到样本不全，无法区分这些原因；现在按组汇总各轮计数。
- 诊断在释放查询前保存独立快照，不增加 GPU 查询或同步等待。样本不完整时仍不计算 GPU 中位数，CPU 与帧间隔结果继续保留。
- 验证：132 项测试通过。两种绘制路径覆盖六类查询状态、四轮汇总、原始样本数量和对照组不受影响；strict、原生/wasm32 Clippy 和生产构建通过。
- 诊断只记录观察到的查询状态，不推断驱动故障或硬件性能；disjoint 会使整组 GPU 结果失效，轮数和查询计数不能相加作为缺失帧数。schemaVersion 3 保留，新增字段不改变既有字段含义。

## 2026-10-21 · 重建失败后的上下文恢复

- 修复资源重建失败后，后续上下文丢失和恢复被忽略的问题。新的上下文周期会重新释放旧资源并尝试重建，成功后清除错误；重复恢复事件和逐帧检查不会反复触发分配。
- 引擎页不再因一次重建失败永久停用。失败期间显示错误、禁止绘制和跑分，恢复后保留场景、相机与暂停状态，并重新启用控件。
- 验证：122 项测试通过，覆盖连续两次分配失败、第三次恢复、恢复前零绘制、等待期间无重复分配，以及两种绘制路径的像素一致性；strict、原生/wasm32 Clippy 和生产构建通过。
- 重试依赖浏览器提供新的上下文恢复事件，不主动循环申请资源；没有后续恢复时仍需刷新。故障注入不代表永久驱动故障的恢复能力。

## 2026-10-20 · 缓冲容量分配校验

- 修复实例矩阵缓冲未取得请求容量时，渲染器仍构造成功的问题。现在检查实际字节数，失败后释放缓冲及 program 并返回明确错误。
- 旧 RustRenderer 对顶点、索引、矩阵和颜色缓冲统一检查容量；上传失败时释放全部已创建资源，避免留下半初始化的渲染器。零实例的零字节缓冲仍可使用。
- 上下文恢复时同样校验容量，分配失败后保持 failed 状态，禁止提交绘制；解除故障后可重新创建引擎。
- 验证：118 项测试通过，覆盖五个存储分配位置、失败清理、零容量、重新创建和恢复失败阻断；strict、原生/wasm32 Clippy 和生产构建通过。故障注入验证错误处理，不等同于真实驱动显存耗尽测试。

## 2026-10-19 · 几何体拓扑替换

- 新增 `Engine.replaceGeometry(id, positions, indices)` 和 Rust `replace_geometry()`，允许已有几何体改变顶点数与三角形索引，保持资源 ID、材质和场景引用。
- 新缓冲与 VAO 创建、上传并检查容量后才替换旧几何；输入或分配失败时释放临时资源并保留原几何。成功后同步所有引用组的包围球，上下文恢复使用最新拓扑。
- 验证：115 项测试通过。两种绘制路径覆盖 32 次扩容/缩容、共享引用、三角形统计、五类分配失败、旧资源释放及两次上下文恢复；strict、原生/wasm32 Clippy 和生产构建通过。
- 替换期间新旧 GPU 资源短暂共存，会增加峰值占用；固定拓扑的频繁更新仍使用 `updateGeometry()`。该接口不负责新增或卸载几何体。

## 2026-10-19 · 固定拓扑的几何更新

- 新增 `Engine.updateGeometry(id, positions)` 和 Rust `update_geometry()`，可更新已有顶点位置，复用缓冲和 VAO，顶点数量与索引拓扑保持不变。
- SDK 自动重算所有引用组的局部包围球，并使旧队列失效；受影响组的自定义包围球会被替换，其他组保留。球心按 f32 存储后计算半径并向外舍入，基础几何体半径也不再向内舍入。
- 顶点、索引和批次映射独立保存，外部输入修改不会改变恢复后的几何；上下文丢失期间可更新，恢复时使用最新顶点。非法输入不覆盖原几何。
- 验证：112 项测试通过。两种路径连续更新 64 次未新建 GPU 对象，检查共享几何跨材质引用、剔除、退化三角形和两次上下文恢复；strict、原生/wasm32 Clippy 和生产构建通过。更新仍有 CPU 复制、包围体计算和上传成本，改变拓扑或资源数量仍需重建。

## 2026-10-19 · 材质原地更新

- 新增 `Engine.updateMaterial(id, color, unlit)` 和 Rust `update_material()`，已有材质的颜色及光照开关可在下一帧生效，所有共享该材质的对象同步变化，无需重建场景、几何体或批次。
- 材质参数独立保存，上下文丢失期间可继续修改，恢复后使用最新值；修改外部输入或颜色数组不会改变已保存的参数。
- 无效 ID、非有限或越界颜色、稀疏数组会被拒绝且保留原材质；dispose 后禁止更新。材质增删、纹理与透明度暂未支持。
- 验证：104 项测试通过。两种绘制路径连续更新 64 次未新建 program、buffer 或 VAO，像素、共享引用、无效编辑和两轮上下文恢复均通过；strict、原生/wasm32 Clippy 和生产构建通过。

提交：[db3aa55](https://github.com/sakorman/three-wasm-rust/commit/db3aa553dc4c5172a38aec6fed018480caa97362)

## 2026-10-16 · 点投影的数值校验

- 修复 `transform_points()` 将有效的小 w 误判为零的问题；等价的齐次矩阵缩放不再仅因绝对阈值而失败。
- 点变换的乘加与齐次除法使用 f64 中间值，完成除法后写回 f32，避免中间乘积溢出把有限结果变成 Infinity 或 NaN。
- 零 w 或最终坐标超出 f32 范围时，整次调用报错并给出点编号；输入数组不变，不返回部分结果。负 w 允许参与数学变换，接口不负责视锥裁剪。
- 验证：101 项测试通过，覆盖 Three.js 差分、等价矩阵缩放、大数抵消、批量失败及两种绘制路径的像素对照；strict、原生/wasm32 Clippy 和生产构建通过。GPU 顶点投影与原始输入精度不受此改动提升。

## 2026-10-16 · 矩阵乘法的抵消精度

- 修复大数相消时局部小偏移被舍入成零的问题。矩阵乘法使用 f64 乘积与累加，完成后再写回 f32，场景层级与公开乘法接口共用此实现。
- 避免中间乘积超出 f32、但最终结果有限时产生 NaN；单矩阵和批量接口会拒绝最终超出 f32 范围的结果。
- 更新两类性能报告的精度说明。输入、逐层世界矩阵和 GPU 数据仍为 f32，不会恢复已经丢失的输入精度，也不承诺任意量级差下都能准确抵消。
- 验证：93 项测试通过，包含 Three.js 数学差分、脏更新/全量更新及两种绘制路径的像素对照；strict、原生/wasm32 Clippy 和生产构建通过。

## 2026-10-15 · GPU 样本完整性

- 修复部分 GPU 查询缺失时仍显示中位数的问题。现在每个记录帧都返回有效结果后才计算；样本不全时显示“采样不全”，CPU 和帧间隔结果仍保留。
- JSON 新增 `gpuExpectedSamples`，缺失时 `gpuStatus` 为 `incomplete`、`gpuMedian` 为 null，已返回的原始样本继续保留，便于排查。
- 拒绝负数和非有限时长；避免重复 begin 覆盖活动查询，dispose 后禁止重启；disjoint 会结束并释放活动查询，保持失效状态。
- 验证：27 项 Node、36 项浏览器测试、strict 类型检查和生产构建通过。故障注入覆盖两种对照的完整 96/96 样本与缺失 72/96 样本；模拟查询不代表实际 GPU 跑分。

## 2026-10-15 · 稳定表面光照

- 修复物体移到大坐标后，表面起伏丢失、亮度异常变化的问题。法线改用去除平移的相对坐标计算。
- 叉乘前缩放表面导数，避免极大或极小缩放导致法线归一化异常；零长度法线使用环境亮度，unlit 直接输出基础颜色。
- Rust、Three.js 对照和旧实验页同步更新 shader。顶点投影仍使用 f32，这项修复不解决全部大世界坐标精度问题。
- 验证：79 项测试通过，覆盖 ±1e8 平移、1e-12 / 1e12 缩放、镜像和 unlit；CI、生产构建及线上像素检查通过。

提交：[e458cb0](https://github.com/sakorman/three-wasm-rust/commit/e458cb03cea67c5c3acc942c7c2feb7e0a86e022)

## 2026-10-15 · 拒绝失效场景提交

- 世界矩阵更新检查非有限值，层级缩放溢出时明确报告节点编号；修正变换后可恢复绘制。
- 渲染队列绑定场景版本。修改、更新或释放场景后，旧队列失效；逐对象绘制拒绝混用其他场景的队列。
- 错误检查在清屏、矩阵上传和绘制之前完成，覆盖逐对象、实例化与旧 RustRenderer。
- 验证：76 项测试通过；异常路径未提交 GPU 命令，恢复后像素与原画面一致；CI、构建和线上检查通过。

提交：[ea06345](https://github.com/sakorman/three-wasm-rust/commit/ea06345fed2ca05c593077d8d2380e4800c83eb6)

## 2026-10-14 · 保守剔除与数值边界

- 修复微小剪切下包围球半径偏小，导致画面边缘对象被误剔除的问题。
- 使用矩阵最大拉伸的保守上界计算半径；平面提取、球心与半径计算使用 f64 中间值，矩阵存储和上传仍为 f32。
- 修复极端缩放的平方上溢、下溢，以及等价投影矩阵因整体缩放被误判为退化的问题。
- 保留 Three.js 原生包围球算法，说明剪切下的差异；两边工作量不同时拒绝输出性能报告。
- 验证：68 项测试通过；剪切场景开启和关闭剔除的像素一致，CI、构建和线上检查通过。

提交：[b932673](https://github.com/sakorman/three-wasm-rust/commit/b93267393f3c7ecb9dd0c1e76d7f593d127d2600)

## 2026-10-14 · 非原点包围球

- 新增可选的 `EngineScene.centers` 和 `RenderQueue.set_bounds()`，支持球心偏离几何体局部原点；省略球心时兼容原有输入。
- 球心随完整世界矩阵变换，支持父子层级、旋转、缩放和镜像。Rust 与两种 Three.js 对照读取同一组包围球。
- 更新包围球后使旧队列失效；拒绝长度错误、非有限坐标和负半径，保留原有有效数据。
- 验证：60 项测试通过，包含 500 个包围球的差分测试、相机移动及上下文恢复。CI、构建和线上检查通过。

提交：[409b966](https://github.com/sakorman/three-wasm-rust/commit/409b966e974985cc9dc88eba7ecafb9fbc2ef3fa)

## 2026-10-13 · 镜像与负缩放

- 按世界矩阵朝向切换正面绕序，修复负缩放导致表面被错误剔除的问题，支持父节点镜像和双重镜像抵消。
- 实例化路径按几何体、材质和朝向分组；Rust 与 Three.js 均拆分正反朝向批次，保持绘制策略一致。
- 缩放符号变化后重新确定朝向与批次，逐对象路径保持场景顺序。
- 验证：54 项测试通过，包含单面三角形正反视图、批次迁移及实际绘制次数；CI、构建和线上检查通过。

提交：[43e1677](https://github.com/sakorman/three-wasm-rust/commit/43e16773c50be5e8945354ad09a24941db3d99b7)

## 2026-10-13 · 图形恢复

- 新引擎在 WebGL 上下文恢复后重建 GPU 资源，保留场景、相机与动画状态。
- 中止失效期间的性能采样，丢弃旧 GPU 查询，恢复后可重新测试。
- 修复渲染队列校验失败后可能保留上一帧绘制数据的问题。
- 新增故障注入和恢复后像素对照测试。

提交：[1160b4b](https://github.com/sakorman/three-wasm-rust/commit/1160b4b6e3cfb16ba0bd00d73040f3638f7d9896)、[c705a9f](https://github.com/sakorman/three-wasm-rust/commit/c705a9fa2c1a0d97b92356dba435bde5ac55467b)

## 2026-10-12 · 精简界面

- 删除测试口径、报告上下文和底部介绍段落。
- 状态提示缩短，释放空间给画布，保留全部结果指标。

## 2026-10-11 · 工作台界面

- 首页改成一屏工作台，集中放置参数、双画布和测试结果。
- 使用浅色操作区和固定的 Rust / Three.js 颜色标记；窄窗口将结果并排排成两列。
- 固定采样和结果区尺寸，避免按钮或数据出现时改变画布大小。
- 检查 532×863、390×844、1024×640、1280×720、1440×900 的完整结果均不溢出。
- 系统开启减少动态效果时，初始暂停场景动画。

## 2026-10-10 · 0.3.0

- 新增 Rust 逐对象 drawElements 路径，不创建实例矩阵缓冲。
- 默认对照改为两边不实例化、全量矩阵更新、场景顺序绘制，剔除默认关闭。
- 实例化优化保留为独立的成对测试。
- 采样采用 AB / BA 四轮，导出前核对两边绘制工作量。
- 增加真实 WebGL 调用统计测试，验证两边每帧普通绘制数一致且实例化调用为零。

## 2026-10-10 · 0.2.0

- Rust 场景图加入脏矩阵更新、父子变化传播和更新数量统计。
- 新增视锥剔除队列、多几何体/材质注册与自动批次绘制。
- 独立实现轨道相机、盒体、圆柱和球体；提供街区、仓库、机械阵列场景。
- 首页改为同步视角的并排对照，保留普通 Three.js Mesh 和实例化优化组。
- 新增三组串行采样、CPU 中位/P95、帧间隔、异步 GPU 查询和 JSON 报告。
- 旧的 CPU 小型测试移到 lab.html，全量矩阵计算保持可比。

## 2026-10-10 · TypeScript

- 前端、Vite / Playwright 配置和测试改用 TypeScript。
- 复用 WASM 生成类型，补齐场景数据、性能报告和页面元素类型。
- 加入 strict 类型检查，随测试和生产构建一起执行。
- Node 差分测试改用 tsx 运行，Rust 接口保持兼容。

## 2026-10-10 · 文档

- 补充场景数据布局、矩阵更新和内存管理的实现笔记。
- 整理 README，更新页面文案和截图。

## 2026-10-10 · 0.1.0

- Rust 矩阵计算、场景图和 WebGL2 实例化渲染。
- Rust、Three.js 和混合模式演示。
- 五项基准测试，支持导出 JSON。
- 7 项 Rust 测试、8 项 WASM 差分测试、5 项浏览器测试。
- GitHub Actions CI 和手动 Pages 部署。
