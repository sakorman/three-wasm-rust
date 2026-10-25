# 高斯光栅化准备

Rust/WASM 高斯准备接口包含三维协方差投影、屏幕支持范围、不透明度与深度筛选、稳定排序和范围打包。候选可先按不透明度与相机深度筛选，再进入投影和排序。完整 3DGS 的加载、SH 着色和实际光栅接入仍需继续。

## 公式与接口

### 三维协方差投影

`gaussian_project_covariances()` 接收相机空间中的中心和三维协方差，按像素焦距与主点计算二维屏幕协方差。每个协方差按 `[xx, xy, xz, yy, yz, zz]` 传入，返回 `[pixelX, pixelY, depth, screenXX, screenXY, screenYY]`。相机空间约定 `z > 0` 表示在相机前方。

对中心 `(x, y, z)` 使用透视投影 `u = fx × x / z + cx`、`v = fy × y / z + cy`，在该点取 Jacobian：

```text
J = [ fx/z       0       -fx*x/z² ]
    [  0       fy/z      -fy*y/z² ]
Σscreen = J × Σcamera × Jᵀ
```

计算阶段使用 f64，转换为 f32 后检查中心、深度和协方差仍有限，并检查返回协方差满足 `xx > 0`、`yy > 0`、`xx × yy > xy²`。行列式检查将实际 f32 分量提升到 f64，避免检查过程自身下溢。投影与 `gaussian_screen_bounds()` 共用这一约束；失败时错误包含原始高斯索引，整批不返回部分结果，输入和已有返回数组保持不变。

三维协方差为单位阵时，中心 `[0, 0, 1e30]`、单位焦距会将二维方差舍入为零；中心 `[100000, 100000, 1]` 会使三个二维分量均变成 `1e10`，行列式变成零。两种输入现在都在投影阶段报错。最小正 f32 方差仍可返回；接口不设置固定最小半径，也不静默增大方差或剔除问题高斯。调用方需调整视域、尺度，或明确选择滤波策略。

返回数组按每项 6 个分量交错存储。批量调用范围接口前需提取每项后三个协方差分量；排序取第三个深度分量，打包输入则是范围接口输出的半宽/半高。正定校验保证数值输出可以进入范围接口，但不保证任意极端协方差的逆矩阵都能在 GPU f32 中表达。

该一阶投影适合接到范围收紧、深度排序和 binary16 打包之前；宽视场、靠近相机平面或相机位于椭球内部时，仿射 Jacobian 可能不足，应增加裁剪或评估更精确的投影。

设计与 `gsplat` 的标准 3DGS 投影步骤一致：[rasterization API](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst)。当前实现只提供独立 CPU/WASM 数值内核，没有复制其 CUDA 代码，也没有接入真实模型或 GPU 管线。

### 屏幕范围

采用 `alpha(d) = opacity × exp(-0.5 × dᵀ Σ⁻¹ d)`，Σ 的单位为像素平方。阈值为 τ 时，保留区域满足 `dᵀ Σ⁻¹ d ≤ 2 ln(opacity / τ)`。设右侧为 k，则轴对齐半宽和半高分别为 `sqrt(k × Σxx)` 与 `sqrt(k × Σyy)`；旋转由 Σxy 表达，不需要用最大特征值同时扩大两轴。

```ts
import { init, gaussian_screen_bounds } from './web/engine/index.ts';

await init();
const halfExtents = gaussian_screen_bounds(
  new Float32Array([16, 3, 9, 4, -1, 2]), // 每个高斯 [xx, xy, yy]
  new Float32Array([0.2, 0.001]),
  Math.fround(1 / 255),
);
// 每项 [halfWidth, halfHeight]；低于阈值为 [0, 0]
```

计算使用 f64，中间半径向外扩展一个 f32 步长，再加半像素边距并向外舍入。等于阈值的高斯保留半像素范围，避免丢掉正好位于像素中心的有效样本。片元阶段必须使用同样的阈值规则：仅当 `alpha < cutoff` 时丢弃。

协方差必须有限且正定；不透明度须在 `[0, 1]`，阈值须在 `(0, 1]`，最多一百万项。整批校验后才计算，非法输入不返回部分结果，原数组不变。返回值为独立的 Float32Array。该接口不执行协方差正则化，也不保证任意病态协方差或低精度 shader 的数值行为。

### 不透明度索引

如果只需要压缩待投影列表，可先调用稳定索引筛选：

```ts
import { gaussian_visible_indices } from './web/engine/index.ts';

const opacities = new Float32Array([0.2, 0.001, 0.5]);
const visible = gaussian_visible_indices(opacities, Math.fround(1 / 255));
// Uint32Array [0, 2]，对应原始数据的位置
```

索引筛选与支持范围使用同一个 `opacity >= cutoff` 规则。它只检查峰值不透明度，不代表视锥或遮挡可见性；后续阶段仍需按返回索引读取协方差、中心、SH 和深度。结果为独立的 Uint32Array，保持原顺序，不进行深度排序或自动压缩其他数组。不透明度与阈值固定时可缓存列表，编辑或淡入淡出后需重新筛选。

输入最多一百万项，所有不透明度必须有限且在 `[0, 1]`，阈值必须在 `(0, 1]`。先完整校验，再返回结果；失败不修改输入或返回部分索引。筛选需要 O(N) 扫描和 JS/WASM 数组传输，输出占用 4K 字节（K 为保留项数），它本身不分配 GPU 资源。

### 近远深度筛选

`gaussian_clip_depth_indices(depths, candidates, near, far)` 按 `near ≤ depth ≤ far` 筛选中心，返回原始索引的独立 Uint32Array，保持候选顺序。它可接在不透明度筛选之后，先排除相机后方、相机平面及近远范围外的中心，再收集相机空间中心与协方差传入投影接口。

```ts
import { gaussian_clip_depth_indices, gaussian_depth_order } from './web/engine/index.ts';

const depths = new Float32Array([-1, 0, 0.5, 2, 4, 10, 11]); // 相机空间 z，前方为正
const candidates = new Uint32Array([4, 0, 5, 1, 3, 2, 6]);
const clipped = gaussian_clip_depth_indices(depths, candidates, 2, 10);
// [4, 5, 3]：保留原始 ID，包含 near=2 与 far=10 的中心
const order = gaussian_depth_order(depths, clipped);
// [5, 4, 3]：筛选后另行排序
```

深度与两个边界均采用 f32。`near` 必须有限且大于零；`far ≥ near`，可用 `Infinity` 关闭远端限制。所有深度都必须有限，即使对应项不在候选中；最多一百万个深度，候选必须唯一且不越界。失败不返回部分结果，也不修改输入。等于边界的中心保留，正负零均在正近平面之外。

该接口只筛选中心，不裁切椭球或屏幕四边形；中心在范围外但支持范围跨越平面的高斯仍会被移除，不属于保守包围体剔除。它不做左右/上下视口、遮挡或协方差校验，也不保证范围内的投影不会退化。深度应取相机前向坐标；WebGL 视空间通常使用 `-z`，不能直接传入 NDC 深度或相机到中心的欧氏距离。

复杂度为 O(N + K)：校验全部 N 个深度、K 个候选并筛选，另有去重位图、输出数组和 JS/WASM 复制成本。后续投影可以只处理保留项，但这不是 GPU 或端到端速度结论。收集子集后，投影输出按子集顺序排列，需保留原始 ID 映射，才能正确读取颜色、SH 等属性。

### 深度顺序

```ts
import { gaussian_depth_order } from './web/engine/index.ts';

const depths = new Float32Array([1, 5, 5, 0.5]); // 数值越大，离相机越远
const candidates = new Uint32Array([0, 2, 1]);
const order = gaussian_depth_order(depths, candidates);
// Uint32Array [2, 1, 0]；相同深度 5 保留候选中 2、1 的顺序
```

输出是原始高斯索引的独立副本，按深度从大到小排列。输入可先使用 `gaussian_visible_indices()` 缩小候选集，再结合几何可见性筛选。传入通常为相机前向的线性深度，例如 WebGL 视空间 z 的相反数；接口也定义负深度的数值顺序，但不会剔除相机后方对象，也不把欧氏距离或 NDC 深度自动转换成所需深度。

相等深度保留候选输入顺序，`+0` 和 `-0` 视作相等；相邻 f32 值不合并到粗桶。深度数组必须全部有限，最多一百万项；候选索引不能重复或越界，避免同一高斯重复混合。空候选返回空数组，输入数组不会被修改。

实现为 Rust CPU/WASM 的四轮 8-bit 稳定基数排序。符号位映射将有限 f32 转成可排序整数键，再执行计数、前缀和、稳定散射；它不是论文中的 WebGPU 并行排序。校验和排序复杂度为 O(N + K)，N 为深度数，K 为候选数；需要候选副本、临时缓冲和去重位图，JS/WASM 传输仍有复制成本。相机或高斯中心改变后需更新深度并重排。

排序仅依据给定的 f32 中心深度，不能恢复输入量化前的差异，也不解决相互穿插高斯的逐像素遮挡关系；同深度稳定性只在候选相对顺序不变时成立。

## 可复现结果

256×192 WebGL2 合成测试包含 28 个圆形、旋转椭圆及重叠高斯，不透明度覆盖 0–1。参考四边形按最坏峰值 1 计算范围，两边片元使用相同的真实不透明度、协方差、阈值、颜色、混合和绘制顺序。

| 指标 | 统一最坏范围 | 按不透明度收紧 |
| --- | ---: | ---: |
| 提交四边形总面积（像素²） | 15,110.25 | 5,877.31 |
| 绘制次数 | 28 | 20 |
| RGBA 不同通道数 | — | 0 |

提交面积减少 **61.10%**，该测试的输出像素完全一致。面积按提交几何计算，不是 GPU 片元调用计数或 FPS 提升。另有阈值相等/略低/略高的边界测试。结果写入 `test-results/**/gaussian-coverage.json` 并随 CI artifact 保留。

索引压缩回归使用 `[0, 0.99τ, τ, 0.2, 1]`，返回 `[2, 3, 4]`，与支持范围为零的项目完全一致；输入顺序和原数组均保持不变。

浏览器另外比较“遍历全部 28 项并检查零范围”与“按紧凑索引遍历 20 项”。两条路径提交相同的 20 个高斯，使用原索引读取颜色与其他属性，RGBA 完全一致。减少的是筛选之后的遍历项数；四边形面积、绘制次数与上一版收紧路径相同，不据此宣称新的 GPU 或端到端加速。

深度排序回归对 65,537 个输入深度先筛选再反转候选，与 JavaScript 稳定排序逐项比较；覆盖混合正负深度、相邻浮点数、同深度、正负零和输入不变。WebGL 用两个重叠、alpha 均为 0.5 的高斯验证后向前混合，结果与独立排序参考逐像素一致，中心颜色与解析合成值相差不超过一个 8-bit 色阶。未经排序的相反绘制顺序会产生不同颜色。结果写入 `test-results/**/gaussian-sort.json`。

投影回归以透视映射的数值差分建立 Jacobian，对照 128 组三维各向异性协方差，覆盖焦距、离轴中心、尺度和深度变化。另检查 f32 下溢、奇异和非正定输出的批次拒绝，保留最小正 f32 方差。浏览器在三次拒绝后重新投影正常数据，串联范围、排序、binary16 解包和透明绘制，与未压缩参考逐像素比较；报告保存为 `test-results/**/gaussian-projection.json`。

深度筛选以 65,537 项输入对照 JavaScript 的不透明度筛选、深度条件和稳定排序。浏览器用例的 8 个高斯中，7 个通过不透明度筛选，3 个通过 `[2, 10]` 深度范围；未经筛选的整批投影会因相机后方中心报错，筛选后正确保留近远边界项及其不透明度，绘制 2,074 个可见像素，与 f32 范围参考 RGBA 一致。报告保存为 `test-results/**/gaussian-clip.json`；这验证的是筛选规则和管线衔接，不代表裁剪前后的画面应当相同。

```bash
cargo test --locked gaussian::tests
npm run build:wasm
npx tsx --test tests/gaussian.test.ts
npx tsx --test tests/gaussian-projection.test.ts
npm run test:e2e -- tests/browser/gaussian-projection.spec.ts
npm run test:e2e -- tests/browser/gaussian.spec.ts
npx tsx --test tests/gaussian-sort.test.ts
npm run test:e2e -- tests/browser/gaussian-sort.spec.ts
npx tsx --test tests/gaussian-clip.test.ts
npm run test:e2e -- tests/browser/gaussian-clip.spec.ts
```

尚未对真实重建模型验证 PSNR、SSIM、帧率或跨设备收益；CPU 计算、数组复制和 JS/WASM 传输也有成本。现有 Mesh 对照没有使用该接口。

## 文献与项目

参考版本核对日期：2026-10-26。

| 来源 | 与当前设计的关系 |
| --- | --- |
| [WebSplatter 论文](https://arxiv.org/abs/2602.03207) · [项目](https://websplatter.github.io/) · [代码版本 16bb06e](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be) | 参考不透明度支持范围与完整 32-bit 稳定排序的设计。论文半径采用 exp(-r²) 坐标约定，这里以协方差写成 exp(-q/2)。实现为独立 Rust CPU/WASM 内核，不沿用论文的 GPU workgroup 同步或速度结论。 |
| [Gaussian-Splat-Lite 1.4.2 更新](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/8576bb70d6f26884f7ca69ddf7f9b3b303e41484/CHANGELOG.md) · [仓库](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) | 2026-10-24 的版本将随机渲染改为每高斯一个三角形，并调整慢速运动中的去噪细节。当前保留排序 alpha 混合基线，随机覆盖和去噪需另测噪声、时序稳定性及总开销。 |
| [Gaussian-Splat-Lite RAD 缓存预算](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/commit/d99a6294159c3b5cedcf610fd41ac875d7d29246) | 2026-10-25 的查看器分别设置 CPU/GPU 常驻缓存预算，修改后保留视角重载。后续流式资产管理应分别统计两类内存；当前尚无模型分页或淘汰机制。 |
| [Gaussian-Splat-Lite 固定 RAD 槽位](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/commit/a1b86e002447d98059de0ef7b706ffdbad0f5c81) | 2026-10-25 改为每槽 65,536 个高斯，小块占整槽，超出单槽上限的块在初始化时拒绝。后续资源池复用可参考固定容量与完整槽位预算的取舍，当前尚未实现 RAD 加载。 |
| [3DGEER，ICLR 2026](https://arxiv.org/abs/2505.24053v3) · [代码](https://github.com/boschresearch/3dgeer) | 关注通用相机下的射线高斯积分与关联。它提醒投影近似误差和光栅开销是不同问题；当前屏幕范围优化不解决宽视场投影误差。 |
| [`gsplat` 投影 API](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) | 说明用透视投影 Jacobian 将三维协方差近似为二维协方差；本接口采用相同数学关系，使用独立 Rust/WASM 实现。 |
| [gsplat 滤波参数](https://docs.gsplat.studio/main/apis/rasterization.html) · [Mip-Splatting 论文与项目](https://niujinshuchong.github.io/mip-splatting/) | `eps2d` 调整投影协方差；抗锯齿模式还补偿不透明度。滤波会影响覆盖和亮度，应明确配置并验证缩放下的画质。本接口目前只检查返回精度，不自动套用滤波，也不将数值拒绝称为抗锯齿。 |
| [gsplat 近远平面参数](https://docs.gsplat.studio/main/apis/rasterization.html) · [WebSplatter 预处理](https://arxiv.org/html/2602.03207v1#S3.SS2) | 参考在投影/绘制前限制候选的设计。本接口明确采用中心深度的闭区间，不复现论文的视口包围盒剔除，也不移用其他实现的性能结论。 |

上游论文中的性能与画质数字不作为本仓库结果。参考实现的代码许可分别以各仓库 LICENSE 为准；这里发布的内核与测试不包含其代码、模型或图片。

## 轴数据压缩

`gaussian_pack_half_extents()` 将 `[halfWidth, halfHeight]` 对编码成一个 `u32`，低 16 位和高 16 位分别是 IEEE 754 binary16。它适合将支持范围从 CPU/WASM 传给后续渲染阶段：每个高斯从 8 字节降到 4 字节，保留非负值和原始顺序。

```ts
import { gaussian_pack_half_extents } from './web/engine/index.ts';

const packed = gaussian_pack_half_extents(halfExtents);
// packed.length === halfExtents.length / 2
// shader 中按 binary16 解包为 halfWidth / halfHeight
```

输入必须是成对的有限 `[0, 65504]` f32，最多一百万项。每个分量向上舍入到不小于原值的最小 binary16，保证解码后的包围范围不收缩；正负零均编码为零，极小正数至少编码为 `2⁻²⁴`。超出范围会拒绝，调用方可保留原始 f32 路径。输出为独立 Uint32Array，输入不变。

最近偶数舍入不适合保守范围：例如半宽 `2048.750244140625` 会缩到 `2048`，超过半像素边距；向外舍入则得到 `2050`。片元仍用原协方差和阈值计算 alpha，扩大的四边形只影响覆盖候选，不改变高斯方程。该保证仅针对范围量化，不消除 GPU 坐标计算或片元精度误差。

数值回归遍历全部 31,744 个非负有限 binary16 编码，并检查相邻编码之间的 f32 邻点与中点。WebGL2 回归实际调用 `unpackHalf2x16`，在旋转/重叠椭圆、阈值边界及大范围边缘三组测试中与原始 f32 范围逐像素一致。大范围负对照使用旧舍入宽度时有 3 个 RGBA 通道不同，向外舍入后为 0。报告保存在 `test-results/**/gaussian-pack.json`。

每项编码数据量仍为 4 字节，向外舍入可能增加候选片元；尚未测量真实模型的 GPU 带宽、帧率或画质收益，现有 Mesh 对照不使用该接口。

排序后的轴数据可使用 binary16 打包，形成“筛选 → 投影 → 打包 → 排序 → 光栅”的准备链路。WebSplatter 论文也将投影椭圆的两个轴压为 16-bit float 后传给光栅阶段；本接口保持 Rust/WASM 语义独立，不复制其 WebGPU shader 或同步实现。

```bash
npx tsx --test tests/gaussian-pack.test.ts
npm run test:e2e -- tests/browser/gaussian-pack.spec.ts
```
