# 高斯光栅化准备

Rust/WASM 高斯准备接口包含原始训练 PLY 的受限解码、0–3 阶球谐颜色求值、模型到相机空间的仿射变换、三维协方差投影、仿射半空间裁切系数、屏幕低通滤波与不透明度补偿、屏幕支持范围、不透明度/中心或支持范围深度/视口筛选、稳定排序、瓦片分箱和范围打包。候选可先在模型坐标系求值视角颜色，再转换到相机空间，按不透明度与相机深度筛选，投影、滤波并重算范围后按视口范围筛选、排序和分箱。GPU 着色和主场景接入仍需继续。

## 训练 PLY 输入

`parseGaussianSplatPly(buffer)` 解码原始 3D Gaussian Splatting 训练代码写出的 `binary_little_endian 1.0` PLY 顶点记录。调用前需完成 `init()`；函数返回独立的 `centers`、`covariances`、`opacities`、DC `colors`，以及系数主序 RGB 的 `shCoefficients` 和 `shDegree`，不创建 GPU 资源。它要求顶点元素排在其他元素之前，并要求下列字段都是 f32：

```text
x y z
f_dc_0 f_dc_1 f_dc_2
opacity
scale_0 scale_1 scale_2
rot_0 rot_1 rot_2 rot_3
```

完整且连续的 `f_rest_0…f_rest_8`、`f_rest_0…f_rest_23` 或 `f_rest_0…f_rest_44` 会分别识别为 1、2、3 阶 SH；其布局是每个基函数一个 RGB 三元组。其他未知或不完整的 `f_rest_*` 组保持未消费，兼容仅含 DC 或带额外标量的输入。解析器拒绝顶点列表属性、ASCII/大端格式、重复或缺失必填字段、截断数据、超过一百万项的数据，以及非有限值；不会猜测其他 PLY 变体的字段语义。

`scale_*` 按自然指数激活；`opacity` 使用数值稳定的 sigmoid；`rot_*` 按 `[w, x, y, z]` 归一化。Rust/WASM 在 f64 中构造 `R × diag(exp(scale)^2) × Rᵀ`，写回 f32 后再次检查三维协方差正定性，输出布局为 `[xx, xy, xz, yy, yz, zz]`。DC 颜色按 `0.28209479177387814 × f_dc + 0.5` 还原为线性 RGB，负值截为零以满足当前上传记录的非负颜色约束。`evaluateGaussianPlyShColors(source, modelCameraPosition)` 在 Rust/WASM 中使用同一约定求 0–3 阶实球谐，添加原始 3DGS 的 `+0.5` 偏置并截断负值；相机位置必须与模型空间 `centers` 使用同一坐标系。

```ts
import { init, parseGaussianSplatPly, prepareGaussianPlyForThreeCamera } from './web/engine/index.ts';

await init();
const source = parseGaussianSplatPly(await response.arrayBuffer());
const modelToWorld = Float32Array.from(model.matrixWorld.elements);
const prepared = prepareGaussianPlyForThreeCamera({
  source,
  modelToWorld,
  threeWorldToView: Float32Array.from(camera.matrixWorldInverse.elements),
  threeCameraWorldPosition: Float32Array.from(camera.getWorldPosition(new THREE.Vector3()).toArray()),
  cutoff: 1 / 255,
  camera: { focalX, focalY, principalX, principalY, near: camera.near, far: camera.far, width, height },
  tileSize: 16,
});
```

### 模型到相机空间

`transformGaussianPlyToCameraSpace(source, worldToCamera)` 接收列主序的 4×4 仿射矩阵，返回新的相机空间数组，不会改写 PLY 源数组。对模型空间中心 `c` 和协方差 `Σ`，线性部分为 `R`、平移为 `t` 时：

```text
c_camera = R × c + t
Σ_camera = R × Σ × Rᵀ
```

平移不改变协方差；实现以 f64 计算并在返回 f32 后再次检查正定性。准备和投影路径约定相机前方为 `z > 0`。标准 Three.js `matrixWorldInverse` 使用负 z 前方；`composeThreeModelToPositiveZCamera(modelToWorld, threeWorldToView)` 在一次 WASM 调用中返回 `diag(1, 1, -1, 1) × threeWorldToView × modelToWorld`，可直接交给本接口。该助手不导入 Three.js，输入是复制后的列主序矩阵；模型、视图和组合结果均须为有限且可逆的仿射矩阵，相机或模型变化后须重新组合。接口拒绝透视矩阵、奇异线性部分、非有限中心及非正定协方差；投影除法无法对三维高斯协方差保持上述仿射关系。

`prepareGaussianPlyForThreeCamera()` 将上述四个步骤连成一次准备：先把世界相机位置反解为模型空间以求 SH，再组合正 z 相机矩阵、变换中心和协方差，最后调用 `prepareGaussianRaster()`。它返回独立的紧凑视图，矩阵、相机位置或源数组更新后须重新调用；它不自动订阅 Three.js 变换，也不会自动将结果上传到首页 Mesh 场景。其底层 `modelCameraPositionFromThreeWorld(modelToWorld, worldCameraPosition)` 拒绝投影、奇异、非有限或 f32 不可表示的结果。当前未实现 GPU SH 着色、色彩管理、曝光、色调映射或 PLY 流式加载。此处的格式和激活约定参照原始实现的 [PLY 属性顺序与激活](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/scene/gaussian_model.py)、[`gsplat` SH 工具说明](https://docs.gsplat.studio/main/apis/utils) 及 [SH 常数](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/utils/sh_utils.py)；变换关系参考 [3D Gaussian Splatting](https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/)；未使用其代码、模型或实验数据。

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

### 半空间裁切系数

`gaussian_halfspace_clip_coefficients()` 为每个相机空间高斯准备一个裁切三元组 `[kx, ky, h]`。平面保留侧为 `dot(normal, position) ≤ offset`；法线与偏移会一起归一化，因此按同一非零比例缩放两者仍表示同一平面。近平面 `z ≥ near` 可传入 `normal = [0, 0, -1]`、`offset = -near`。

对投影中心与当前像素的位移 `delta = screenCenter - pixel`，片元阶段将原有 alpha 乘以：

```text
Φ(kx × delta.x + ky × delta.y + h)
```

其中 `Φ` 是标准正态 CDF。令 `J` 为投影 Jacobian、`A = JΣJᵀ`、`b = JΣn`，系数为：

```text
s² = nᵀΣn - bᵀA⁻¹b
k  = A⁻¹b / s
h  = (offset - nᵀcenter) / s
```

```ts
import { gaussian_halfspace_clip_coefficients } from './web/engine/index.ts';

const clip = gaussian_halfspace_clip_coefficients(
  cameraCenters, cameraCovariances, focalX, focalY,
  new Float32Array([0, 0, -1]), -near,
);
// 每项 [kx, ky, h]；片元阶段以 normal CDF 乘原有 alpha。
```

接口使用与投影接口一致的 f32 屏幕协方差，并拒绝无效中心、协方差、焦距或平面。仿射条件方差因屏幕坐标已确定某个平面方向而退化时，`s²` 最小按 `1e-8` 处理以保持输出有限；这是一项数值保护，不是更精确的几何裁切。

当前结果只准备系数，主渲染器尚未上传它或在片元中实现 CDF。该模型只覆盖局部仿射 EWA 近似；宽视场、相机接近或位于高斯内部、多个高斯的合成顺序仍需在完整渲染路径中验证。它不提供模型级 PSNR、SSIM、GPU 时间或帧率结论。公式参考 [XClipGS](https://arxiv.org/abs/2608.07760)，实现不包含其代码、模型或实验数据。

### 屏幕低通滤波

`gaussian_filter_screen_covariances()` 接收投影后的二维协方差 `[xx, xy, yy]`、峰值不透明度和像素平方单位的 `filterVariance`，返回每项 `[filteredXX, filteredXY, filteredYY, compensatedOpacity]`。它在二维屏幕空间执行各向同性滤波：

```text
Σ′ = Σ + εI
ρ  = sqrt(det(Σ) / det(Σ′))
α′ = α × ρ
```

`α′` 使单个未截断连续高斯的 `α × sqrt(det(Σ))` 保持不变。实现先将 `Σ′` 写入 f32，再用实际返回的 f32 协方差计算行列式和补偿，避免输出协方差与峰值不透明度不匹配。`filterVariance = 0` 原样返回输入；大到无法表示的输出或任何无效协方差会整批报错。

```ts
import { gaussian_filter_screen_covariances, gaussian_screen_bounds } from './web/engine/index.ts';

const filtered = gaussian_filter_screen_covariances(
  projectedCovariances, opacities, 0.3,
);
// 每项四个数：[xx, xy, yy, opacity]；拆分后重算范围并上传绘制。
```

滤波会改变协方差与峰值不透明度，因此不能复用旧的范围、binary16 打包或视口筛选结果；相机、分辨率或 `filterVariance` 改变后应重新计算这些阶段。公式与 [`gsplat` 的 antialiased 模式](https://docs.gsplat.studio/main/apis/rasterization.html)中的视角相关补偿一致；[Mip-Splatting](https://openaccess.thecvf.com/content/CVPR2024/html/Yu_Mip-Splatting_Alias-free_3D_Gaussian_Splatting_CVPR_2024_paper.html)则说明屏幕 Mip 滤波和三维平滑分别处理不同的混叠来源。

该接口不做三维平滑、真实近平面裁切或 SH 着色。连续积分守恒不等同于 alpha 合成后的像素亮度、多个高斯重叠、阈值丢弃或不同分辨率下的 PSNR/SSIM 相同；真实模型仍需逐视角测量。

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

### 近远支持范围筛选

`gaussian_clip_depth_support_indices(centers, covariances, opacities, candidates, cutoff, near, far)` 按三维高斯在 z 轴上的阈值支持范围筛选，而不是只看中心。输入中心为相机空间 `[x, y, z]`，协方差为 `[xx, xy, xz, yy, yz, zz]`。当 `opacity ≥ cutoff` 时，令 `k = 2 ln(opacity / cutoff)`，椭球 `dᵀΣ⁻¹d ≤ k` 沿相机 z 的最大偏移为：

```text
r_z = sqrt(k × Σzz)
```

接口保留闭区间 `[z - r_z, z + r_z]` 与 `[near, far]` 相交的候选。该结论包含协方差交叉项：在椭球约束下，z 方向的极值只由 `Σzz` 决定。等于 `cutoff` 时 `r_z = 0`，与中心筛选一致；低于阈值的项不返回。内部以 f64 计算并向外扩展对数、半径和端点，避免数值舍入把相切支持误剔除。

```ts
import { gaussian_clip_depth_support_indices, gaussian_depth_order } from './web/engine/index.ts';

const candidates = gaussian_clip_depth_support_indices(
  cameraCenters, cameraCovariances, opacities, visibleIndices,
  Math.fround(1 / 255), near, far,
);
const order = gaussian_depth_order(
  Float32Array.from(opacities, (_, index) => cameraCenters[index * 3 + 2]),
  candidates,
);
```

中心必须在相机前方，全部中心、协方差和不透明度都会校验，即使不在候选列表中；协方差需为正定，候选必须唯一且不越界。该接口只决定是否保留候选，不对椭球做近平面几何裁切，也不消除近平面附近的一阶透视投影误差。保留候选可再交给半空间裁切系数接口，但实际光栅器仍需在片元阶段应用 CDF。

### 屏幕视口筛选

`gaussian_viewport_indices(centers, halfExtents, candidates, width, height)` 保留与 `[0, width] × [0, height]` 相交的轴对齐范围。中心和半宽/半高均按 `[x, y]` 成对传入，单位为绘制缓冲像素；宽高为有限正 f32。四边相切的范围保留，任一半宽/半高为零的项排除。

```ts
import { gaussian_viewport_indices } from './web/engine/index.ts';

const centers = new Float32Array([-2, 96, 128, 96, 300, 96]);
const halfExtents = new Float32Array([12, 8, 12, 8, 12, 8]);
const visible = gaussian_viewport_indices(centers, halfExtents, new Uint32Array([2, 0, 1]), 256, 192);
// [0, 1]：第 0 项中心虽在屏幕外，范围仍覆盖左侧像素
```

端点加减在 f64 中向外舍入，避免有限 f32 的大数加减溢出或收缩范围。输入最多一百万项；全部中心须有限，全部半宽/半高须有限且非负，即使该项不在候选中也要满足。候选不能重复或越界；返回独立 Uint32Array，保留原始 ID 和候选顺序，不修改输入。

范围须覆盖实际绘制几何，不能只用中心判断。若后续使用 binary16 半宽，传入解包后的实际范围或更大的保守范围，避免量化扩大几何后沿用较小的剔除范围。视口尺寸应使用 canvas 绘制缓冲尺寸，不是 CSS 尺寸；相机、范围或画布尺寸变化后需重新筛选。

该接口只做二维范围相交，不负责投影、近远深度、遮挡或精确椭圆与矩形求交；保留项仍可能不产生片元。保守性针对给定范围，不涵盖任意病态协方差或 GPU 坐标运算误差。复杂度 O(N + K)，包含全部范围校验、候选去重位图与输出分配，JS/WASM 传输仍有复制成本。

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

### 瓦片分箱

`gaussian_tile_bins(centers, halfExtents, candidates, width, height, tileSize)` 把屏幕空间的轴对齐范围分配到行优先的绘制瓦片。返回的 `Uint32Array` 前 `tileCount + 1` 项是偏移，余下为原始高斯 ID；第 `t` 个瓦片的候选位于 `[offsets[t], offsets[t + 1])`。`tileCount = ceil(width / tileSize) × ceil(height / tileSize)`，其中 `width`、`height` 和 `tileSize` 都是正整数像素。

```ts
import { gaussian_depth_order, gaussian_tile_bins } from './web/engine/index.ts';

const ordered = gaussian_depth_order(depths, visibleCandidates);
const packed = gaussian_tile_bins(screenCenters, halfExtents, ordered, canvas.width, canvas.height, 16);
const tileCount = Math.ceil(canvas.width / 16) * Math.ceil(canvas.height / 16);
const offsets = packed.subarray(0, tileCount + 1);
const ids = packed.subarray(tileCount + 1);
// 第 tile 项：ids.subarray(offsets[tile], offsets[tile + 1])
```

分箱以 f64 向外计算范围端点；与视口或瓦片边界相切的高斯保留，半宽或半高为零以及完全离屏的项不产生引用。每个瓦片中的 ID 严格沿用输入候选顺序。若输入已经按全局中心深度稳定排序，这个顺序在每个瓦片中仍然成立；也可在分箱后调用下述接口独立建立瓦片内顺序。两者都只是中心深度规则，不是逐像素精确排序。

为约束 WASM 和 JS 侧分配，单次最多支持 1,000,000 个瓦片与 4,000,000 个高斯—瓦片引用；超出时整批报错，不返回部分缓冲。该接口只生成 CPU/WASM 的分箱描述，不提交 GPU 命令、不改变高斯数据，也不保证相邻瓦片之间的复用、带宽或帧率收益。

### 瓦片内深度顺序

`gaussian_tile_depth_order(depths, packed, tileCount)` 复制 `gaussian_tile_bins()` 的偏移—ID 缓冲，并对每个瓦片的 ID 按中心深度从远到近稳定排序。偏移表保持不变；同深度（含正负零）保持该瓦片内原始顺序。由于打包缓冲不带元数据，调用方必须传入原网格的 `tileCount`。

```ts
import { gaussian_tile_bins, gaussian_tile_depth_order } from './web/engine/index.ts';

const packed = gaussian_tile_bins(screenCenters, halfExtents, visibleCandidates, width, height, 16);
const tileCount = Math.ceil(width / 16) * Math.ceil(height / 16);
const orderedPacked = gaussian_tile_depth_order(cameraDepths, packed, tileCount);
const offsets = orderedPacked.subarray(0, tileCount + 1);
const ids = orderedPacked.subarray(tileCount + 1);
```

`depths` 必须全部是有限 f32；偏移必须从零开始、单调且末项等于 ID 数。同一 ID 可以出现在不同瓦片，但不能在同一瓦片重复。接口逐批校验这些约束以及深度、瓦片和引用上限，失败不返回部分结果。实现使用 CPU/WASM 稳定基数排序和一块按最大瓦片复用的临时缓冲；不执行 GPU 键值排序，也不代表帧率收益。

### 视图准备

`prepareGaussianRaster()` 将已有的 WASM 内核组合为一份相机视图数据：不透明度筛选、近远支持范围筛选、投影、可选屏幕滤波、范围、视口筛选和中心深度排序依次执行；可选地附加半空间裁切系数和瓦片分箱。它不创建 WebGL 资源，因此可用于不同的 WebGL/WebGPU 上传策略。

```ts
import { init, prepareGaussianRaster } from './web/engine/index.ts';

await init();
const prepared = prepareGaussianRaster({
  centers: cameraCenters,
  covariances: cameraCovariances,
  opacities,
  colors: linearRgb,
  cutoff: 1 / 255,
  camera: { focalX, focalY, principalX, principalY, near, far, width: canvas.width, height: canvas.height },
  filterVariance: 0.3,
  clipPlane: { normal: new Float32Array([0, 0, -1]), offset: -near },
  tileSize: 16,
});
// originalIds、屏幕属性、colors 与 clipCoefficients 都按远到近的紧凑局部顺序排列。
```

`colors` 可选传入每项非负线性 RGB 三元组；省略时准备阶段写入白色，保持旧调用的灰度结果。`originalIds` 将紧凑顺序映射回源属性；`tiles.packed` 的 ID 则索引紧凑输出数组，不是源 ID。这样顶点/片元上传不必再间接索引原始数组，也避免将视口筛选后的局部 ID 当成源 ID。滤波后的不透明度、协方差、颜色和范围在同一条链路内保持对齐；相机、画布、阈值、滤波或平面改变后应重新准备。

输入布局先在 TypeScript 检查，再交由各 WASM 阶段完整校验；无效批次不返回部分准备结果。`tileSize` 存在时，画布宽高和瓦片大小必须是正整数。此接口未加载 PLY/SOG、未实现 SH、未上传 GPU 缓冲，也不在主渲染器执行 CDF；浏览器回归只证明准备数据可供片元裁切使用，不代表真实模型性能或画质。

### 上传数据打包

`packGaussianRasterUpload()` 将 `prepareGaussianRaster()` 的紧凑结果复制为固定的交错 f32 记录，供一个实例化顶点缓冲直接读取。每项为 15 个 f32（60 字节）：

```text
[centerX, centerY, halfWidth, halfHeight,
 conicXX, conicXY, conicYY, opacity,
 clipX, clipY, clipH, clipEnabled,
 red, green, blue]
```

`conic` 是返回的二维协方差的逆矩阵独立分量，片元可计算 `q = conicXX·dx² + 2·conicXY·dx·dy + conicYY·dy²`。`clipEnabled = 0` 时片元应跳过 CDF；启用后使用三个裁切系数。RGB 保持非预乘线性值，片元合成时与 alpha 相乘。函数再次校验数组长度、唯一源 ID、有限值、正定协方差、非负颜色和可表示的 f32 逆矩阵，并深拷贝源 ID 与瓦片数据，避免 CPU 数组在排队上传后被改写。

```ts
import { GAUSSIAN_RASTER_UPLOAD_STRIDE, packGaussianRasterUpload } from './web/engine/index.ts';

const upload = packGaussianRasterUpload(prepared);
gl.bindBuffer(gl.ARRAY_BUFFER, splatBuffer);
gl.bufferData(gl.ARRAY_BUFFER, upload.splatData, gl.DYNAMIC_DRAW);
// stride = GAUSSIAN_RASTER_UPLOAD_STRIDE * Float32Array.BYTES_PER_ELEMENT
```

瓦片偏移—引用缓冲保留在 `upload.tiles`，引用的是交错记录的局部索引；`originalIds` 仅用于回查源属性。该函数不拥有或释放 WebGL 缓冲，不处理上下文丢失，也不声明带宽、GPU 时间或帧率收益；资源复用与实际绘制器仍需单独接入。

### 可复用上传缓冲

`GaussianUploadBuffers` 将上传记录保存在独立 CPU 副本中，并以指定的 `ContextLifecycle` 管理一对 WebGL2 缓冲。`update()` 在容量足够时使用 `bufferSubData`，增长时才重新分配；瓦片数据缺失时释放瓦片缓冲。`clear()` 会同时释放 CPU 副本和当前 VBO，但保留对象及其上下文订阅，供后续 `update()` 重新上传；清空后的上下文恢复不会重传旧视图。它只保存数据和句柄，不创建 VAO、shader 或绘制提交。

`resourceStats()` 分别返回内部交错记录、源 ID、瓦片引用副本的精确 TypedArray 字节数，以及当前可用 VBO 的容量。上下文丢失、分配失败、`clear()` 或 `dispose()` 后 GPU 容量为零；丢失期间 CPU 副本仍保留，以便恢复时重传。该快照不包含 PLY 原文、绘制器的 program/VAO、JavaScript 对象、驱动开销或实际显存，不能用于推断显存、GPU 时间或性能。

```ts
import { ContextLifecycle, GaussianUploadBuffers } from './web/engine/index.ts';

const lifecycle = new ContextLifecycle(gl);
const buffers = new GaussianUploadBuffers(gl, lifecycle);
buffers.update(upload);
const gpu = buffers.snapshot(); // ready 时返回 VBO、可用字节数和容量
const resources = buffers.resourceStats(); // 上传副本字节数与当前 VBO 容量
buffers.clear(); // 卸载当前视图；随后可调用 update(upload) 重新建立缓冲
```

上下文丢失时 `snapshot()` 返回 `undefined`，旧 WebGL 句柄不会再暴露；恢复后自动以内部副本新建缓冲并重传。调用方在恢复后的 `snapshot()` 中重新绑定 VAO 和属性即可。传入数组在 `update()` 后可以修改，不会影响恢复内容。该类尚未接入首页 Mesh 场景或完整高斯主渲染器；缓冲容量、上传次数和本节 WebGL 测试均不是 GPU 时间、帧率或显存收益结论。

### 独立光栅 pass

`GaussianRasterRenderer` 消费 `PackedGaussianRasterUpload`，创建自己的 program 与 VAO，并以记录中的中心、范围、逆协方差、不透明度、线性 RGB 和可选 CDF 系数执行一次 `drawArraysInstanced`。它使用预乘线性 RGB alpha、源列表的远到近顺序和 `ONE / ONE_MINUS_SRC_ALPHA` 混合；调用前的 program、VAO、数组缓冲、viewport 与混合状态会在返回前恢复。

```ts
import { GaussianRasterRenderer } from './web/engine/index.ts';

const renderer = new GaussianRasterRenderer(gl, lifecycle);
renderer.update(upload);
renderer.draw({ width: 1280, height: 720, cutoff: 0.01, applyClip: true });
```

绘制器和上传缓冲共同订阅同一个 `ContextLifecycle`：恢复时先重传 VBO，再重建 program/VAO。`draw()` 按全局紧凑顺序绘制；存在瓦片数据时，`drawTiles()` 验证网格与 viewport 一致，并按保存的行优先瓦片—局部 ID 顺序设置 scissor。`GaussianRasterRenderer.clear()` 会委托上传层卸载当前视图，保留 program/VAO；清空后 `draw()` 会拒绝，新的 `update()` 后可恢复绘制。`GaussianRasterRenderer.resourceStats()` 透传上传层快照，不计绘制器自身的 program 或 VAO。内部只迭代数值 ID，不暴露可修改的偏移/引用数组。

同一瓦片中连续递增的局部 ID 指向连续的交错 VBO 记录，可作为一条 `drawArraysInstanced` 提交；`forEachTileBatch()` 只合并这种最大连续段。遇到跳号或逆序 ID 会立即结束当前段，保持原有混合顺序。`drawTiles()` 的返回值仍是引用数量而非 draw call 数。该实现没有 GPU 级间接索引，不能合并任意稀疏 ID，也不把合并次数推断为 GPU 时间、帧率或端到端性能收益。瓦片内按深度排序、再 alpha 合成的流程可参照 [`gsplat` rasterization](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst)。

绘制器不提供球谐、纹理、深度/透明度策略或主页面接入。因此该 pass 只验证已有几何、颜色与裁切数据的 GPU 执行，不是完整 3DGS 渲染器，也不用于性能、画质或显存结论。

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

半空间裁切系数回归以 4,097 组正定协方差和独立公式参考核对 `[kx, ky, h]`，并检查平面等比例缩放及整批输入拒绝。256×192 WebGL2 用例在一个穿过中心的斜平面上实际应用 CDF：左右采样 alpha 分别为 15 与 0，中心采样按其半像素坐标得到 CDF 因子 0.4723179，共有 1,166 个可见像素。报告保存为 `test-results/**/gaussian-halfspace.json`；这只验证单高斯的局部裁切方向，不代表完整近平面裁切、混合质量或性能结果。

视图准备回归使用四个相机空间高斯：支持范围阶段保留四项，视口阶段移除一项离屏候选，输出源 ID 为远到近的 `[2, 1, 0]`。16 像素瓦片产生 52 条局部引用。把输出裁切系数用于片元 CDF 后，相对未裁切路径有 23,264 个不同 RGBA 通道和 1,976 个可见像素；报告保存为 `test-results/**/gaussian-prepare.json`。该数据只用于检查映射、顺序与裁切衔接，不作为绘制次数、GPU 时间或画质比较。

上传打包回归将同一份准备数据以 15-f32 交错属性上传到真实 WebGL2 VBO，并以一次 3 实例绘制执行 CDF 片元路径。记录步长为 60 字节，VBO 实际容量为 180 字节；包含 52 条引用的瓦片缓冲容量为 980 字节。裁切相对未裁切有 23,264 个不同通道、1,976 个可见像素，`gl.getError()` 为零；报告保存为 `test-results/**/gaussian-upload.json`。容量是该合成输入的缓冲大小，不是带宽、帧率或显存收益。

上传缓冲恢复回归先上传 3 条记录和瓦片数据，再更新为 2 条记录，数据缓冲容量维持 180 字节并只进行子更新。资源快照分别报告记录、源 ID 与瓦片副本，以及可用 VBO 容量；触发真实 `WEBGL_lose_context` 后 GPU 容量归零，恢复前写入的新上传数据仍保留 CPU 副本，恢复后 VBO 容量和首项中心与写入时一致。该结果只验证所有权、容量和恢复语义，不代表完整场景的资源占用或恢复时间。

独立光栅 pass 回归以同一份 3 条上传记录分别执行裁切和未裁切绘制，二者产生 23,264 个不同 RGBA 通道；恢复前后裁切图像逐字节一致。回归还设置非默认混合因子并确认 draw 返回后恢复。另有两个非重叠记录的 RGB 回归：红色与青色记录在对应中心保持预乘颜色分量。该结果只检查着色器、属性布局、透明混合和恢复顺序，不比较瓦片调度、GPU 时间、帧率或真实模型质量。

瓦片绘制回归将同一份 16 像素网格的 52 条局部引用送入 `drawTiles()`；每个 tile 以 scissor 限制像素区域，输出与一次全屏紧凑绘制逐字节一致。调用前关闭 scissor 并设为 `[2, 3, 4, 5]`，返回后状态和盒子保持不变。连续局部 ID 会以一条实例化调用提交，浏览器回归确认调用数小于引用数；逆序 ID 的单元测试确认会拆段并保持原顺序。该结果只检查提交语义，不代表 GPU 时间、帧率或端到端性能。

深度筛选以 65,537 项输入对照 JavaScript 的不透明度筛选、深度条件和稳定排序。浏览器用例的 8 个高斯中，7 个通过不透明度筛选，3 个通过 `[2, 10]` 深度范围；未经筛选的整批投影会因相机后方中心报错，筛选后正确保留近远边界项及其不透明度，绘制 2,074 个可见像素，与 f32 范围参考 RGBA 一致。报告保存为 `test-results/**/gaussian-clip.json`；这验证的是筛选规则和管线衔接，不代表裁剪前后的画面应当相同。

支持范围回归以 4,097 组有限 f32 三维协方差和 f64 公式参考核对，不丢失与深度区间相交的候选。浏览器用例中，4 个不透明候选以中心筛选只会留下 1 个；支持范围筛选保留 3 个，其中两个中心分别在近平面前与远平面后。3 个支持候选的绘制有 4,303 个可见像素，与同候选参考 RGBA 完全一致；错误地只保留中心项会产生 14,627 个不同通道。报告保存为 `test-results/**/gaussian-depth-support.json`。此用例尚未实现真实近平面裁切，不把像素差异解释为真实模型质量或性能结论。

视口回归用 BigInt 表示 f32 的精确二进制值，核对 4,097 个随机范围在三组视口尺寸下的相交结果，包含次正规量级与极端端点。256×192 浏览器用例有 36 项输入，28 项具有非零支持范围；移除 4 个完全离屏范围后提交 24 次绘制，3,635 个可见像素与未筛选参考完全一致。f32 与实际 binary16 解包范围两条路径均通过；只判断中心是否在画布内的负对照会丢失边缘像素，产生 2,161 个不同 RGBA 通道。报告保存为 `test-results/**/gaussian-viewport.json`。这些是合成用例的工作量与画面结果，不是实际模型帧率收益。

屏幕滤波回归以 4,097 组正定 f32 协方差与 f64 行列式公式对照，检查滤波后的 f32 输出、补偿不透明度及连续积分。512×512 的单高斯 WebGL2 用例将 `[16, 5, 9]` 与 `α=0.7` 加入 `ε=0.6`：像素 alpha 字节和从 12,166 变为 12,152，且解析积分相对差小于 `2e-6`。该结果只验证本滤波公式在合成单高斯上的数值和像素管线，不是模型级抗锯齿或画质结论。报告保存为 `test-results/**/gaussian-filter.json`。

瓦片分箱与局部排序回归以 4,097 个屏幕范围和深度对照独立的行优先 JavaScript 参考，检查离屏、边界相切、偏移格式、同深度稳定性和跨瓦片 ID 复用。256×192 WebGL2 用例中，8 个重叠候选生成 23 条瓦片引用；逐瓦片稳定排序后的合成与全局远到近参考逐通道一致，有 1,124 个可见像素。故意跳过局部排序会产生 1,651 个不同通道。瓦片路径提交 23 个四边形、全屏参考提交 8 个，结果只用于验证覆盖和混合顺序，不衡量性能；报告保存为 `test-results/**/gaussian-tiles.json`。

```bash
cargo test --locked gaussian::tests
npm run build:wasm
npx tsx --test tests/gaussian.test.ts
npx tsx --test tests/gaussian-filter.test.ts
npx tsx --test tests/gaussian-tiles.test.ts
npx tsx --test tests/gaussian-projection.test.ts
npx tsx --test tests/gaussian-halfspace.test.ts
npx tsx --test tests/gaussian-prepare.test.ts
npx tsx --test tests/gaussian-upload-buffers.test.ts
npm run test:e2e -- tests/browser/gaussian-projection.spec.ts
npm run test:e2e -- tests/browser/gaussian-halfspace.spec.ts
npm run test:e2e -- tests/browser/gaussian-prepare.spec.ts
npm run test:e2e -- tests/browser/gaussian-upload.spec.ts
npm run test:e2e -- tests/browser/gaussian-filter.spec.ts
npm run test:e2e -- tests/browser/gaussian-tiles.spec.ts
npm run test:e2e -- tests/browser/gaussian.spec.ts
npx tsx --test tests/gaussian-sort.test.ts
npm run test:e2e -- tests/browser/gaussian-sort.spec.ts
npx tsx --test tests/gaussian-clip.test.ts
npm run test:e2e -- tests/browser/gaussian-clip.spec.ts
npx tsx --test tests/gaussian-depth-support.test.ts
npm run test:e2e -- tests/browser/gaussian-depth-support.spec.ts
npx tsx --test tests/gaussian-viewport.test.ts
npm run test:e2e -- tests/browser/gaussian-viewport.spec.ts
```

尚未对真实重建模型验证 PSNR、SSIM、帧率或跨设备收益；CPU 计算、数组复制和 JS/WASM 传输也有成本。现有 Mesh 对照没有使用该接口。

## 文献与项目

参考版本核对日期：2026-10-27。

| 来源 | 与当前设计的关系 |
| --- | --- |
| [WebSplatter 论文](https://arxiv.org/abs/2602.03207) · [项目](https://websplatter.github.io/) · [代码版本 16bb06e](https://github.com/websplatter/WebSplatter/tree/16bb06e86b8fb12193d4bb4cd2b0b3d4f3ab62be) | 参考不透明度支持范围与完整 32-bit 稳定排序的设计。论文半径采用 exp(-r²) 坐标约定，这里以协方差写成 exp(-q/2)。实现为独立 Rust CPU/WASM 内核，不沿用论文的 GPU workgroup 同步或速度结论。 |
| [Gaussian-Splat-Lite 1.4.2 更新](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/blob/8576bb70d6f26884f7ca69ddf7f9b3b303e41484/CHANGELOG.md) · [仓库](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) | 2026-10-24 的版本将随机渲染改为每高斯一个三角形，并调整慢速运动中的去噪细节。当前保留排序 alpha 混合基线，随机覆盖和去噪需另测噪声、时序稳定性及总开销。 |
| [Gaussian-Splat-Lite RAD 缓存预算](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/commit/d99a6294159c3b5cedcf610fd41ac875d7d29246) | 2026-10-25 的查看器分别设置 CPU/GPU 常驻缓存预算，修改后保留视角重载。后续流式资产管理应分别统计两类内存；当前尚无模型分页或淘汰机制。 |
| [Gaussian-Splat-Lite 固定 RAD 槽位](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/commit/a1b86e002447d98059de0ef7b706ffdbad0f5c81) | 2026-10-25 改为每槽 65,536 个高斯，小块占整槽，超出单槽上限的块在初始化时拒绝。后续资源池复用可参考固定容量与完整槽位预算的取舍，当前尚未实现 RAD 加载。 |
| [Gaussian-Splat-Lite SOG 环境加载选项](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/commit/607bc79aebe4932c2475f09ae65426e4772d4aeb) | 2026-10-25 新增可关闭的环境加载选项，以保留场景细节预算。后续流式加载需要明确环境与主体数据的预算分配；当前尚未实现 SOG 加载。 |
| [3DGEER，ICLR 2026](https://arxiv.org/abs/2505.24053v3) · [代码](https://github.com/boschresearch/3dgeer) | 关注通用相机下的射线高斯积分与关联。它提醒投影近似误差和光栅开销是不同问题；当前屏幕范围优化不解决宽视场投影误差。 |
| [XClipGS](https://arxiv.org/abs/2608.07760) | 给出仿射 EWA 下以条件高斯 CDF 表达半空间裁切的系数关系。这里独立实现 CPU/WASM 系数准备与单高斯像素回归；未采用其 CUDA 实现、模型、实验设置或性能数据。 |
| [`gsplat` 投影 API](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) | 说明用透视投影 Jacobian 将三维协方差近似为二维协方差；本接口采用相同数学关系，使用独立 Rust/WASM 实现。 |
| [gsplat 滤波参数](https://docs.gsplat.studio/main/apis/rasterization.html) · [Mip-Splatting 论文](https://openaccess.thecvf.com/content/CVPR2024/html/Yu_Mip-Splatting_Alias-free_3D_Gaussian_Splatting_CVPR_2024_paper.html) · [项目](https://github.com/autonomousvision/mip-splatting) | `eps2d` 调整投影协方差，抗锯齿模式以行列式比补偿不透明度。当前接口独立实现同一二维公式，输出供后续范围/筛选阶段使用；没有移用 CUDA 代码、三维平滑或论文的质量和性能结果。 |
| [`gsplat` 瓦片与深度排序](https://github.com/nerfstudio-project/gsplat/blob/main/docs/source/apis/rasterization.rst) · [WebGPU Gaussian Splatting](https://github.com/lu-m-dev/WebGPU-gaussian-splatting) | `gsplat` 文档将高斯按瓦片分组并按深度排序；后者公开了瓦片交集、键值排序和范围构建的实现取舍。当前内核独立实现 CPU/WASM 的保守分箱与稳定瓦片内排序，不采用其 GPU 代码、性能数字或模型数据。 |
| [gsplat 近远平面参数](https://docs.gsplat.studio/main/apis/rasterization.html) · [WebSplatter 预处理](https://arxiv.org/html/2602.03207v1#S3.SS2) | 参考在投影/绘制前限制候选的设计。深度筛选采用中心深度闭区间，视口相交由单独接口负责；不移用其他实现的性能结论。 |
| [Gaussian Point Splatting](https://doi.org/10.1145/3811272) · [项目](https://github.com/JorisAR/gaussian-point-splatting) | 该项目公开近远平面和分层筛选的使用边界。这里补充的是独立的协方差支持范围候选规则，不采用其随机采样、层级结构或性能数据。 |
| [WebSplatter 屏幕 AABB 筛选](https://arxiv.org/html/2602.03207v1#S3.SS2) | 参考用投影范围与视口相交筛选候选。这里实现独立 Rust/WASM 二维范围接口，保留相切项和候选顺序；没有沿用其 WebGPU 实现或性能数字。 |

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
