# 数学与场景 API


构建后可以从 `pkg/three_wasm_rust.js` 导入接口；`pkg/three_wasm_rust.d.ts` 提供生成的类型声明。

## 创建场景

```js
import init, { SceneGraph } from './pkg/three_wasm_rust.js';

const wasm = await init();
const parents = new Int32Array([-1, 0]); // -1 表示根；节点 1 是节点 0 的子节点
const transforms = new Float32Array([
  // position xyz | quaternion xyzw | scale xyz
  10, 0, 0,        0, 0, 0, 1,        1, 1, 1,
   2, 0, 0,        0, 0, 0, 1,        1, 1, 1,
]);

const graph = new SceneGraph(parents, transforms);
graph.update_world_matrices();
console.log(graph.world_matrices()[16 + 12]); // 12：子节点世界坐标 x

graph.reparent(1, -1); // 保留局部 TRS，变为独立根节点
graph.update_world_matrices();
console.log(graph.world_matrices()[16 + 12]); // 2

graph.free(); // 主动释放 Rust 对象；此后不要继续调用该对象
```

约定如下：

- 一个节点对应 **10 个 f32**：位置 3 个、四元数 4 个、缩放 3 个。
- 四元数使用 `x, y, z, w` 顺序；写入时归一化，零长度四元数会被拒绝。
- 矩阵为 **列主序**，使用列向量，平移在索引 `12, 13, 14`，与 Three.js/WebGL 一致。
- 世界变换为 `parentWorld × local`，局部矩阵为 `T × R × S`。
- 父节点可以出现在子节点之后；遍历顺序由 Rust 在构造/改父节点时计算。
- 不允许循环、自引用、越界父节点、NaN 或 Infinity 输入。输入校验失败的修改不破坏旧场景；世界矩阵更新溢出则使场景及旧队列失效，修正变换并重新更新后恢复。
- 节点上限为 100,000；节点数量固定，需要增删节点时重新创建场景。UI 限制为 20,000。
- 使用迭代式遍历，不因深层级递归而栈溢出。0.2 起只重算脏节点及受影响的后代；索引遍历仍为 O(N)。
- 矩阵乘法先以 f64 计算乘积与累加，最后一次舍入到 f32，减少大数抵消时的小偏移丢失和中间乘积溢出。世界矩阵最终超出 f32 范围时会报错，不继续绘制。
- 局部 TRS、每层世界矩阵和 GPU 数据仍是 f32；该处理不会恢复输入中已丢失的精度，也不保证任意量级差下都能准确抵消。

| 接口 | 作用 |
| --- | --- |
| `new SceneGraph(parents, transforms)` | 校验拓扑、复制输入并计算初始世界矩阵 |
| `node_count()` | 节点数量 |
| `set_transform(id, packed10)` | 更新单个节点局部 TRS |
| `set_transforms(packed10N)` | 批量更新局部 TRS |
| `reparent(id, parent)` | 修改父节点，保留局部变换，拒绝循环 |
| `update_world_matrices()` | 更新脏节点及后代的世界矩阵 |
| `update_all_world_matrices()` | 强制全量重算，用于对照基准 |
| `updated_count()` | 上次实际重算的矩阵数量 |
| `animate_nodes(ids, seconds)` | 覆盖指定节点局部 Y 轴旋转；之后需要更新世界矩阵 |
| `animate_demo(seconds)` | 演示专用：覆盖局部旋转并更新世界矩阵，不用于通用动画系统 |
| `world_matrices()` | 返回独立的 Float32Array 副本 |
| `matrices_ptr()` / `matrices_len()` | 获取借用视图所需的字节指针 / f32 个数 |
| `free()` | 释放 Rust 对象 |

## 把矩阵交给 Three.js

```js
// graph 和 wasm 沿用上例，但应在 graph.free() 之前执行。
// mesh 是已创建的 THREE.InstancedMesh，实例数量必须等于节点数量。
graph.update_world_matrices();
const matrices = new Float32Array(
  wasm.memory.buffer,
  graph.matrices_ptr(),
  graph.matrices_len(),
);
mesh.instanceMatrix.array.set(matrices);
mesh.instanceMatrix.needsUpdate = true;
mesh.frustumCulled = false; // 演示禁用整体剔除，避免沿用已过期包围体
```

**借用视图不是永久引用。** WASM 内存增长会使旧 `ArrayBuffer` / TypedArray 失效；任何可能分配内存的 WASM 调用之后，都应重新获取视图。`graph.free()` 后原视图不能再使用。项目中的 `matrixView()` 每次重建视图，不缓存旧内存。

“借用视图”只省去 WASM 到 JS 的一份数组复制；以上 `.set()` 以及向 GPU 上传仍有数据传输成本。需要长期保存结果时使用 `world_matrices()`。Rust 自有渲染器直接用世界矩阵切片提交 GPU，也不能省去 GPU 上传。

## 旧实验的单批次渲染器

下面是 `lab.html` 保留的 `RustRenderer`。新版多几何体和材质渲染使用 `EngineRenderer`，见 [实现笔记](design.md)。

```js
import { RustRenderer } from './pkg/three_wasm_rust.js';

// canvas: HTMLCanvasElement
// positions: Float32Array，每个顶点 xyz
// indices: Uint32Array，每三个索引构成一个三角形
// colors: Float32Array，每个节点一个 RGB，范围 [0, 1]
const renderer = new RustRenderer(canvas, positions, indices, colors);

// 外部相机生成 projectionMatrix × matrixWorldInverse，按列主序传入。
graph.update_world_matrices();
renderer.render(graph, viewProjectionFloat32Array);

renderer.free(); // 释放 program、VAO、顶点/索引/实例 GPU 缓冲
```

所有节点共享同一份几何体，每个节点都会绘制一个实例。实例颜色在渲染器构造时上传，几何体与颜色不支持原地修改；需要变化时重新创建渲染器。`render()` 不会隐式计算世界矩阵，调用方应先更新。顶点着色器与片元着色器保存在 `web/shaders/`，Rust 与 Three.js 读取同一份源码。

## 数学函数

| 函数 | 输入 / 输出 |
| --- | --- |
| `compose_transform(trs)` | 10 个 f32 → 16 个 f32 |
| `multiply_matrices(a, b)` | 两个 16 元素数组 → `a × b`；最终结果超出 f32 范围时拒绝 |
| `multiply_matrices_batch(a, b)` | 两个 `16 × N` 数组 → N 组矩阵乘积；任意一组溢出则整次调用失败 |
| `transform_points(matrix, points)` | 16 元素矩阵 + xyz 点数组 → 齐次变换后的 xyz；w 接近零时拒绝 |
| `identity_matrix()` | 返回单位矩阵 |
| `identity_value(value)` | 原样返回 f64，供调用开销实验 |

以上数组 API 会通过绑定层复制输入/输出；大量小调用可能比 JS 更慢，优先批量计算或把长期状态保存在 `SceneGraph` 中。
