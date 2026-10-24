# 高斯光栅化准备

Rust/WASM 高斯准备接口包含屏幕支持范围、不透明度筛选和稳定深度排序。低不透明度高斯使用更小的支持范围，低于阈值的高斯可先压缩掉，候选再按中心深度排序。完整 3DGS 的加载、三维协方差投影和 SH 着色仍需接入。

## 公式与接口

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

```bash
cargo test --locked gaussian::tests
npm run build:wasm
npx tsx --test tests/gaussian.test.ts
npm run test:e2e -- tests/browser/gaussian.spec.ts
npx tsx --test tests/gaussian-sort.test.ts
npm run test:e2e -- tests/browser/gaussian-sort.spec.ts
```

尚未对真实重建模型验证 PSNR、SSIM、帧率或跨设备收益；CPU 计算、数组复制和 JS/WASM 传输也有成本。现有 Mesh 对照没有使用该接口。

## 文献与项目

参考版本核对日期：2026-10-24。

| 来源 | 与当前设计的关系 |
| --- | --- |
| [WebSplatter 论文](https://arxiv.org/abs/2602.03207) · [项目](https://websplatter.github.io/) · [代码版本 16bb06e](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be) | 参考不透明度支持范围与完整 32-bit 稳定排序的设计。论文半径采用 exp(-r²) 坐标约定，这里以协方差写成 exp(-q/2)。实现为独立 Rust CPU/WASM 内核，不沿用论文的 GPU workgroup 同步或速度结论。 |
| [Gaussian-Splat-Lite 1.4.2 更新](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/8576bb70d6f26884f7ca69ddf7f9b3b303e41484/CHANGELOG.md) · [仓库](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) | 2026-10-24 的版本将随机渲染改为每高斯一个三角形，并调整慢速运动中的去噪细节。当前保留排序 alpha 混合基线，随机覆盖和去噪需另测噪声、时序稳定性及总开销。 |
| [3DGEER，ICLR 2026](https://arxiv.org/abs/2505.24053v3) · [代码](https://github.com/boschresearch/3dgeer) | 关注通用相机下的射线高斯积分与关联。它提醒投影近似误差和光栅开销是不同问题；当前屏幕范围优化不解决宽视场投影误差。 |

上游论文中的性能与画质数字不作为本仓库结果。参考实现的代码许可分别以各仓库 LICENSE 为准；这里发布的内核与测试不包含其代码、模型或图片。

## 轴数据压缩

`gaussian_pack_half_extents()` 将 `[halfWidth, halfHeight]` 对编码成一个 `u32`，低 16 位和高 16 位分别是 IEEE 754 binary16。它适合将支持范围从 CPU/WASM 传给后续渲染阶段：每个高斯从 8 字节降到 4 字节，保留非负值和原始顺序。

```ts
import { gaussian_pack_half_extents } from './web/engine/index.ts';

const packed = gaussian_pack_half_extents(halfExtents);
// packed.length === halfExtents.length / 2
// shader 中按 binary16 解包为 halfWidth / halfHeight
```

输入必须是成对的有限 `[0, 65504]` f32，采用 round-to-nearest-even；超出 binary16 范围会拒绝。零支持高斯仍编码为零，压缩不改变 `gaussian_visible_indices()` 的筛选语义。binary16 会量化半径，边缘绘制应保留原始 f32 或在 shader 中留出像素边界；当前测试检查典型值、最大有限值、拒绝路径和输入副本，不宣称量化后的真实模型画质等价。

排序后的轴数据可使用 binary16 打包，形成“筛选 → 投影 → 打包 → 排序 → 光栅”的准备链路。WebSplatter 论文也将投影椭圆的两个轴压为 16-bit float 后传给光栅阶段；本接口保持 Rust/WASM 语义独立，不复制其 WebGPU shader 或同步实现。

```bash
npx tsx --test tests/gaussian-pack.test.ts
```
