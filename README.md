# Remote Assist

一个明确授权的远程协助原型，结构接近 ToDesk 的基础链路：

- 被控端运行 `host_agent.py`，主动连接中继服务并生成房间号和口令。
- 控制端在浏览器输入房间号和口令后查看屏幕。
- 控制端可发送鼠标、滚轮、键盘和文本输入事件，并支持全屏查看。

这个项目只适合学习和内网原型验证。生产环境还需要 TLS、账户体系、端到端加密、设备绑定、审计日志、权限分级、文件传输隔离、穿透网络策略和更严格的安全评审。

## 快速运行

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m remote_assist.server
```

另开一个终端作为被控端：

```powershell
.\.venv\Scripts\Activate.ps1
python -m remote_assist.host_agent --relay ws://127.0.0.1:8765 --fps 12 --quality 28 --max-width 960
```

浏览器打开：

```text
http://127.0.0.1:8765/
```

输入被控端终端里显示的 `Room` 和 `Secret`。

如果延迟较大，可以继续降低码流：

```powershell
python -m remote_assist.host_agent --relay ws://127.0.0.1:8765 --fps 12 --quality 28 --max-width 960
```

## 跨设备测试

中继服务默认监听 `0.0.0.0:8765`。同一局域网内，把 `127.0.0.1` 换成运行中继服务机器的局域网 IP：

```powershell
python -m remote_assist.host_agent --relay ws://192.168.1.10:8765
```

控制端访问：

```text
http://192.168.1.10:8765/
```

## 安全边界

- 不支持静默控制。
- 每次共享需要被控端主动运行并看到房间号和口令。
- `pyautogui` 保留 fail-safe：把鼠标移动到屏幕角落会中止自动控制。
- 浏览器控制台有“允许发送鼠标和键盘”开关。
