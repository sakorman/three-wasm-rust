# 高斯光栅化准备

`gaussian_screen_bounds()` 根据投影后的二维协方差、不透明度与 alpha 阈值，计算每个高斯的屏幕四边形半宽、半高。低不透明度高斯使用更小的支持范围，低于阈值的高斯直接跳过。它是 Rust/WASM 光栅准备接口，完整 3DGS 的加载、三维协方差投影、深度排序和 SH 着色仍需接入。

## 公式与接口

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

如果只需要压缩待投影列表，可先调用稳定索引筛选：

```ts
import { gaussian_visible_indices } from './web/engine/index.ts';

const opacities = new Float32Array([0.2, 0.001, 0.5]);
const visible = gaussian_visible_indices(opacities, Math.fround(1 / 255));
// Uint32Array [0, 2]，对应原始数据的位置
```

索引筛选与支持范围使用同一个 `opacity >= cutoff` 规则。它只检查峰值不透明度，不代表视锥或遮挡可见性；后续阶段仍需按返回索引读取协方差、中心、SH 和深度。结果为独立的 Uint32Array，保持原顺序，不进行深度排序或自动压缩其他数组。不透明度与阈值固定时可缓存列表，编辑或淡入淡出后需重新筛选。

输入最多一百万项，所有不透明度必须有限且在 `[0, 1]`，阈值必须在 `(0, 1]`。先完整校验，再返回结果；失败不修改输入或返回部分索引。筛选需要 O(N) 扫描和 JS/WASM 数组传输，输出占用 4K 字节（K 为保留项数），它本身不分配 GPU 资源。

计算使用 f64，中间半径向外扩展一个 f32 步长，再加半像素边距并向外舍入。等于阈值的高斯保留半像素范围，避免丢掉正好位于像素中心的有效样本。片元阶段必须使用同样的阈值规则：仅当 `alpha < cutoff` 时丢弃。

协方差必须有限且正定；不透明度须在 `[0, 1]`，阈值须在 `(0, 1]`，最多一百万项。整批校验后才计算，非法输入不返回部分结果，原数组不变。返回值为独立的 Float32Array。该接口不执行协方差正则化，也不保证任意病态协方差或低精度 shader 的数值行为。

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

```bash
cargo test --locked gaussian::tests
npm run build:wasm
npx tsx --test tests/gaussian.test.ts
npm run test:e2e -- tests/browser/gaussian.spec.ts
```

尚未对真实重建模型验证 PSNR、SSIM、帧率或跨设备收益；CPU 计算、数组复制和 JS/WASM 传输也有成本。现有 Mesh 对照没有使用该接口。

## 文献与项目

参考版本核对日期：2026-10-24。

| 来源 | 与当前设计的关系 |
| --- | --- |
| [WebSplatter 论文](https://arxiv.org/abs/2602.03207) · [项目](https://websplatter.github.io/) · [代码版本 16bb06e](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be) | 采用按不透明度确定支持范围的思路。论文局部坐标写成 exp(-r²)，这里以二维协方差写成 exp(-q/2)，尺度约定不同。Rust 接口按公式独立实现；WebGPU 排序与完整管线未移植。 |
| [Gaussian-Splat-Lite 1.4.1 更新](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/3ba032ffd72c59d3af26a78c21f2fb2622eae8b2/CHANGELOG.md) · [仓库](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) | 近期更新涉及薄高斯方向/宽度、LoD 与运动中的去噪。当前先固定高斯求值和阈值，建立像素基线；LoD 和去噪应单独评测细节、闪烁与开销。 |
| [3DGEER，ICLR 2026](https://arxiv.org/abs/2505.24053v3) · [代码](https://github.com/boschresearch/3dgeer) | 关注通用相机下的射线高斯积分与关联。它提醒投影近似误差和光栅开销是不同问题；当前屏幕范围优化不解决宽视场投影误差。 |

上游论文中的性能与画质数字不作为本仓库结果。参考实现的代码许可分别以各仓库 LICENSE 为准；这里发布的内核与测试不包含其代码、模型或图片。
