# 实现笔记

场景更新、渲染队列和绘制提交各自独立。Rust 引擎路径不调用 Three.js；对照组单独放在 `web/compare/`。0.3 新增逐对象绘制，作为默认性能对照。

## 一帧经过哪些步骤

1. TS 传入绝对动画时间，Rust 更新选定节点的局部四元数。
2. `SceneGraph` 按父节点先于子节点的顺序更新世界矩阵。逐对象对照强制全量重算，实例化对照使用脏标记。
3. `RenderQueue` 提取相机六个平面，对几何体包围球做测试。
4. 逐对象模式保留节点描述顺序；实例化模式再按几何、材质和世界矩阵朝向打包矩阵。
5. 逐对象模式用 modelMatrix uniform 加 drawElements；实例化模式上传矩阵 buffer 并调用 drawElementsInstanced。

光栅化和像素着色在 GPU 上执行。Rust 不逐像素画图。

## 场景图

每个节点保存父索引、10 个 f32 的局部 TRS 和 16 个 f32 的世界矩阵。构造和改父节点时生成拓扑顺序；改父节点先验证副本，拒绝循环后再写回。

脏标记分为节点自身变化和本轮世界矩阵变化。更新时：

```text
worldChanged[id] = localDirty[id] || worldChanged[parent]
```

没有变化的节点不做矩阵乘法，但仍会遍历索引，因此更新遍历是 O(N)，不是 O(脏节点数)。`updated_count()` 记录实际重算的矩阵数。`update_all_world_matrices()` 专门用于强制全量计算和旧的 CPU 基准。

`animate_nodes(ids, seconds)` 是演示动画接口：覆盖指定节点的局部 Y 轴旋转，不是动画混合系统。业务可以使用 `set_transform()` / `set_transforms()` 自己设置 TRS。

## 可见性与分组

`RenderQueue` 的构造输入为可绘制节点索引、组索引、局部包围球半径和组数。每个组对应一个几何体/材质组合，组的映射由 TS 场景构造器生成。每帧在 Rust 中完成计数、偏移计算和矩阵压紧。

球心固定在几何体局部原点，输入半径必须覆盖全部顶点。正交 TRS 使用最大列长度缩放半径；检测到明显剪切时使用 Frobenius 范数保守放大。示例场景没有剪切，与 Three.js 的包围球路径对照。

剔除采用包围体，因此会保留一些实际上没有像素落入画面的对象；它不会做遮挡剔除。标准场景使用正缩放和不透明材质。

负缩放的朝向由世界矩阵左上 3×3 的行列式决定，包含父节点变换。行列式以 f64 求值，避免有限 f32 缩放在乘积中溢出或下溢。小于零时使用 CW，否则使用 CCW；零行列式不标记为镜像。逐对象路径只切换正面状态，仍保留描述顺序。实例化路径在每个资源组内先存 CCW 矩阵，再存 CW 矩阵，每个可见对象只上传一次。

`batch_counts()` 仍返回各资源组的可见对象总数；`batch_count()` 返回非空朝向批次数，同一资源组最多贡献两次实例化绘制。

每帧扫描所有可绘制节点，复杂度 O(M + B)。矩阵空间和组游标预分配，准备队列时不重新分配这些缓冲。

## 渲染资源

EngineRenderer 构造时选择逐对象或实例化模式。两者共用几何体/材质注册，但使用不同顶点 shader。逐对象模式不创建实例 buffer，也不配置实例属性，只更新 modelMatrix uniform 并调用普通 drawElements。几何体和材质不变时复用绑定状态。

实例化模式管理一个动态矩阵 buffer，每个几何体 VAO 引用这个 buffer，切换组时更新矩阵属性偏移。

三个基础几何体由 TS 独立生成，Rust 接受一般索引三角形数组。材质目前只有 RGB 和 unlit 开关；其余使用共享 GLSL 的简单面光照。所有材质均不透明。

`add_geometry()` 和 `add_material()` 返回注册 ID。`set_batches()` 设定队列组到资源 ID 的映射。`render(queue, viewProjection)` 只提交绘制，不会自动更新场景或队列。

逐对象路径调用 `queue.prepare_direct(scene, viewProjection, culling)`，再调用 `renderer.render_direct(queue, scene, viewProjection)`。它不压紧或上传实例矩阵。两条绘制接口会检查队列和渲染器的模式，拒绝混用。

Renderer、Queue、SceneGraph 都有 `free()`。TS 的 Engine 用 `dispose()` 一起释放，重复 dispose 不会重复释放。资源数量变化时重建 Engine；单个资源卸载和动态节点增删暂未实现。

### 上下文丢失与恢复

`ContextLifecycle` 提供只读的 `state`、`generation` 和 `error`，状态为 ready / lost / failed / disposed。Engine 会阻止浏览器放弃恢复，在丢失事件中释放旧 GPU 句柄；收到恢复事件后从场景资源描述重新注册几何体、材质和批次。CPU 侧场景图、已修改的 TRS 和队列继续复用，不重新生成场景。

三个边界需要单独处理：丢失事件晚于 `isContextLost()` 的状态变化时，渲染入口也会拒绝绘制；恢复时资源创建失败则进入 failed；dispose 会移除事件监听，避免已释放的引擎被后续事件重新创建。

对照页在任一后端失效时暂停双方，直到全部可用才继续。Three.js 自身会重建内部 GL 状态，适配器另外恢复用户设置的清屏颜色。浏览器是否以及何时恢复上下文不由引擎保证。

相关接口见 [WebGL 上下文丢失规范](https://registry.khronos.org/webgl/specs/latest/1.0/#5.15.2) 和 [Three.js r186 WebGLRenderer](https://github.com/mrdoob/three.js/blob/r186/src/renderers/WebGLRenderer.js)。

渲染队列每次准备前清空上一轮可见列表并标为无效。输入校验失败时，不允许渲染器继续提交旧列表；下一次有效准备可恢复正常工作。

## 相机和对照组

OrbitCamera 独立生成 look-at 和透视矩阵。两边从同一份 Float32 相机矩阵绘制；Three.js 只在自己的适配器中接收这些矩阵。三种基础几何体的顶点、索引、局部包围球也共用相同输入。

普通组用真正的 Three.js Mesh，矩阵自动更新开启，对象排序关闭。Rust 逐对象组强制全量更新；预设场景的描述顺序与 Three.js 层级遍历的 Mesh 顺序一致。剔除默认关闭，每个对象在两边都对应一次绘制，可选同时开启球剔除。

优化组用 Object3D 保存层级，关闭自动局部矩阵重算，只标记动画节点，然后通过 Three.js 更新世界矩阵。它用 Frustum/Sphere 检查对象，将矩阵写入按几何、材质和朝向组织的 InstancedMesh，只标记有效的矩阵上传范围。普通 Mesh 由 Three.js 处理负缩放；实例化适配器给负行列式组使用 BackSide 材质，令 WebGL 正面切换为 CW，两边均保持背面剔除。该处理针对本项目共享的 RawShaderMaterial，不代表原生 InstancedMesh 的所有材质都支持负缩放。

Three.js 适配器为两种朝向各预留组内最大对象数的矩阵空间，以允许运行中改变缩放符号；每帧只上传可见范围。Rust 使用一个共享矩阵 buffer，总容量仍为对象数。两边绘制的批次、对象和三角形数相同，但缓冲分配方式不同。

只比较策略相同的一对：逐对象 Rust 对普通 Three.js，实例化 Rust 对实例化 Three.js。两者仍有 f32/Number、数据结构和框架开销差异，页面不把结果解释成纯语言速度。

## 测量

实时预览同时跑当前的一对实现。正式基准暂停预览，以 AB、BA、AB、BA 跑四轮，每组使用相同时间序列和冻结相机。提交结果前核对可见对象及三角形数；逐对象模式还检查 draw call 与可见数相等。不匹配的结果不导出。

CPU 从动画/矩阵更新前开始，到绘制提交后结束。准备阶段包括剔除和打包；普通 Three.js 的剔除发生在 render 内，所以在提交阶段。矩阵和视图准备的分工也稍有不同，优先比较总 CPU。

帧间隔采用相邻 rAF 时间戳，包含浏览器调度、刷新率和呈现节奏，不等于纯 CPU 耗时。GPU 查询仅包围绘制提交；结果异步收集，没有 gl.finish。GPU 空闲气泡可能计入查询，无法将它理解成纯光栅化用时。

计时扩展不存在时输出 null；遇到 disjoint 时清空该组 GPU 样本。等待查询结果最多额外经过 8 个 rAF，超时的查询删除，不阻塞 CPU。后台标签页、取消或画布尺寸变化会终止采样。

上下文丢失也会中止采样。每个异步帧边界后核对上下文代次，恢复再快也不接受跨代次结果。等待 rAF 支持 AbortSignal，因此标签页节流或暂停绘制期间也可以立即取消。GPU 查询一旦失效就丢弃，不在新上下文里访问旧查询。

## 可以继续做什么

优先是动态节点/资源管理、AABB 或 BVH 剔除、透明材质排序，以及模型加载。PBR、纹理、阴影和 3DGS 需要更完整的材质与资源系统。现阶段先把基础场景路径和可复现对照保留下来。
