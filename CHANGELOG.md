# 更新记录

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
