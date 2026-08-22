# Runner 实践路径

本文描述[产品策略](strategy.zh-CN.md)中的公开 Runner 边界和目标集成路径；交付顺序与
当前状态以[路线图](roadmap.zh-CN.md)为准。下文的一次性执行内核已经以 preview 形式存在，
长期 `runner start` 客户端和私有平台服务端尚未交付，不能把目标链路当作当前可部署能力。

V0.3 的目标链路是：

```text
私有平台任务 → 发布者自有机器 Runner → digital-employee → Agent Host
             → 标准事件/签名回执 → 平台可信用量 → Credit 结算
```

所有应用/服务机器人都在发布者或运营者自己的电脑或服务器上执行。平台是纯控制面，
不托管员工包和 Agent Host，不保存本地路径或模型凭证，也不要求用户机器开放入站端口。

## 一次任务的顺序

1. 发布者在自己的机器上构建并校验员工包，计算确定性 `packageDigest`。
2. 上架时只把员工身份、版本、摘要、支持的 Engine 和价格版本登记到私有平台；员工包
   字节、本地路径和 Host 凭证留在发布者机器。
3. 买家接受不可变 Quote 后，平台先通过 `ReleaseAuthorizer` 确认该 Quote 对应的员工版本、
   包摘要和 Engine，再预留最大 Credit。
4. Runner 主动出站认领任务。平台返回 Ed25519 签名的完整任务和短租约；heartbeat 每次
   返回新的完整签名租约，不接受裸时间戳续期。
5. Runner 验证平台签名、身份、nonce、有效期和 fencing token，原子消费 replay claim，
   再按身份从本机解析员工包。任务不能指定本地路径。
6. Runner 将员工包复制成单次、只读密封快照，核对同一批字节的摘要后，调用本机显式
   注册的 Agent Host Adapter。
7. Host 事件被规范化并组成 hash chain；模型正文和 chain-of-thought 不进入计量事件。
   Runner 在租约安全窗前停止执行并提交绑定事件数和最终摘要的签名回执。
8. 平台验证当前 attempt、fencing、Runner key、事件链和回执，只把任务推进到待核验。
   独立 `UsageVerifier` 通过后，平台才从不可变 Quote 计算 Credit 并结算。

平台接收端的固定顺序是：从可信注册表解析平台与 Runner 公钥，验证平台 task envelope，
验证 Runner receipt envelope，校验事件链以及身份/时间绑定，再交给独立
`UsageVerifier`，最后按不可变 Quote 结算 Credit。公开的
`verifyRunnerExecutionBundle()` 要求两个签名 envelope 和两把可信注册表公钥，并完成
前三步；它不接受裸 task/receipt。Runner 签名只证明来源和完整性，自报 usage 不能直接
计费。

## 当前可嵌入接口

构建产物通过 `@fullstack-ai-infra/digital-employee/host-runtime` 暴露：

- `computeEmployeePackageDirectoryDigest()`：计算本机员工包摘要；
- `createSealedEmployeePackageSnapshot()`：创建单次密封快照；
- `RunnerLeaseState`：验证初始任务和完整签名续租；
- `executeOneShotRunnerTask()`：验证并执行一个任务，生成事件链和签名回执；
- `RunnerReplayGuardPort`：部署方必须提供的原子防重放端口；
- `InMemoryRunnerReplayGuard`：只用于单进程预览，重启后不安全。

`executeOneShotRunnerTask()` 在签名、身份、lease 或 replay 等前置失败时 reject。nonce
被原子消费后，包身份/摘要、输入或 Host 的确定性失败会正常 resolve，并携带 Runner
签名的失败回执；平台据此结束 attempt，不得用同一个 nonce 重试。
replay claim 必须把已验签的正安全整数 `fencingToken` 原样持久化；同一 task 已有更高 token
时拒绝较低 token，不同 nonce 的相同 token 仍可按原子 claim 语义处理。旧版写入的 `0`
无法还原原 token，因此同一 task 的后续 claim 保守失败关闭。
`InMemoryRunnerReplayGuard` 仅在当前进程生命周期保留有界 task 高水位；nonce 到期清理不会
降低该水位，但进程重启仍会丢失全部状态。`RunnerDurableStorePort` 及内存 reference store
只定义和演示 compare-and-write 语义；生产 durable transaction、崩溃原子性及有界
compaction conformance 仍为 **NOT VERIFIED**。

长期 Runner 的传输层应把平台 API 映射为下面的调用关系，不能把平台返回的路径、命令
或凭证传进执行器：

```ts
const leaseState = await RunnerLeaseState.create({
  initialEnvelope: claimed.envelope,
  resolvePlatformPublicKey,
})

// 独立 heartbeat 循环收到平台完整签名 grant 后：
await leaseState.acceptRenewal(heartbeat.envelope)

const execution = await executeOneShotRunnerTask({
  taskEnvelope: claimed.envelope,
  runnerId: localConfig.runnerId,
  sellerId: localConfig.sellerId,
  resolvePlatformPublicKey,
  resolveLocalPackage: localPackageRegistry.resolve,
  hostRegistry: localHostRegistry,
  replayGuard: durableReplayGuard,
  receiptKeyId: localKey.id,
  receiptPrivateKey: localKey.privateKey,
  leaseState,
  onEvent: platformClient.appendEvent,
})

await platformClient.submitReceipt(execution.signedReceipt)
```

以上是嵌入接口示意，不是已经发布的网络 SDK。真实传输必须把每个 claim、heartbeat、
event 和 receipt 请求绑定到已认证的 Runner 设备主体；task/run/lease id 只是关联字段，
不能当 Bearer Token。

## 公开 Runner 客户端仍需交付

这些能力属于本开源仓库，全部运行在卖家机器上：

- `runner init/doctor/start/status` 生命周期、本地配置和可操作诊断
  （[#35](https://github.com/fullstack-ai-infra/digital-employee/issues/35)）；
- 版本/员工包/Engine 的本地部署注册表，以及只从该注册表解析本地路径；
- 持久化 replay/outbox、崩溃恢复、断线重连、heartbeat、取消、升级和进程清理
  （[#27](https://github.com/fullstack-ai-infra/digital-employee/issues/27)）；
- 设备密钥的本地安全存储与轮换客户端，以及已认证、仅出站的 transport port；具体
  HTTP/gRPC 实现必须在端口之后，执行内核不能依赖私有 API
  （[#29](https://github.com/fullstack-ai-infra/digital-employee/issues/29)）；
- 供应商中立的原始 usage 证据语义，不包含 Quote/Credit 计算
  （[#28](https://github.com/fullstack-ai-infra/digital-employee/issues/28)）；
- committed mock control plane 覆盖签名 claim、本机 Host、断网恢复、事件上传和签名
  receipt 的端到端验证
  （[#37](https://github.com/fullstack-ai-infra/digital-employee/issues/37)）。

当前 `executeOneShotRunnerTask()` 只是上述长期客户端可复用的本机执行内核，不等于
Runner daemon，也不提供生产网络 SDK。公开实现可以提供 mock/参考服务 fixture 来验证
协议，但不能吸收私有平台业务状态。

## 私有平台服务端仍需交付（不进入本仓库）

这些能力属于公司的私有控制面：

- 生产 HTTP/gRPC API、服务端设备注册、身份/凭证签发、可信公钥注册表和轮换策略；
- 任务创建、签名、调度、租约/attempt/fencing 管理、事件接收、事务 outbox、抢占恢复
  和服务端可观测性；
- 真实目录/订单语义的 `ReleaseAuthorizer`，以及独立的 `UsageVerifier`；
- 不可变 Quote、Credit 预留和账本、动态价格、计费、争议、退款、卖家打款、税务与对账；
- marketplace 账户、上架、发现、评价、租赁、UI 和运营后台。

私有平台只消费公开协议，不能导入 Host Adapter 执行代码，不能托管员工包，也不能取得
本地路径或 Agent Host 凭证。在 M1 Runner gate 通过前，本仓库仍是可信边界和本机一次性
执行内核的技术预览，不是可公开运营的机器人租赁平台。
