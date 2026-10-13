# core 测试

本目录的定位：**不为覆盖率数字，为「审计报告里每一条契约类缺陷都有一个对应判据」**。

分三层（见架构方案 R9）：

1. `contract-assertions-test.js` —— 契约断言。把六套声明式契约（域 contract、api SURFACE、
   THIN_SPEC/HELPERS、事件标签、版本向量、ctl limit、schema 校验）变成可执行断言。
   CI 必跑。约 200 行。
2. 状态机穷举测试（后续批次补）——账号 transition 的路径穷举、seq 分配注入失败。
3. 平台行为测试（后续批次补）——kill -9 账本完整性、双进程端口无交集。

运行：`node core/test/contract-assertions-test.js`，退出码 0 为通过。

**纪律**：新增一类声明式契约时，必须同时在这里加对应断言，否则该契约就是新的漂移源。
