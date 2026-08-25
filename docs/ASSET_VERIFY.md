# Local Asset Verification / 本地资产验证

## Local EvoMap asset verification

Run the dependency-free verifier directly with Node. The JSON bundle must contain `payload.assets`; validation is read only from a `Gene`, never from a `Capsule`. For safety, the tool currently accepts only declarations shaped as `bash -n <relative-file>` and executes Bash directly without a shell intermediary. Referenced files are resolved relative to the bundle and may not escape that directory.

```sh
node bin/guard-asset-verify.js /path/to/bundle.json
```

It prints structured JSON containing the two ResultStore events, individual checks, the Passport `create -> review -> resolve` lifecycle, and its timeline. Exit code `0` means every declared check passed; validation failure, malformed input, or an unsupported declaration exits non-zero.

## 本地 EvoMap 资产验证

直接用 Node 运行零依赖验证器。JSON 资产包必须包含 `payload.assets`；工具只读取 `Gene` 上的 validation，绝不会退回读取 `Capsule`。为避免执行任意 shell 内容，目前仅接受 `bash -n <相对文件>` 形式，并直接调用 Bash、不经过 shell 中间层。目标文件相对资产包定位，且不能逃逸该目录。

```sh
node bin/guard-asset-verify.js /path/to/bundle.json
```

输出是结构化 JSON，包含两个 ResultStore 事件、逐项检查、Passport 的 `create -> review -> resolve` 生命周期与时间线。所有声明检查通过时退出码为 `0`；校验失败、输入格式错误或不支持的声明均以非零退出码结束。
