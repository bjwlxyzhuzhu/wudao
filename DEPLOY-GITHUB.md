# 舞安智护：GitHub 镜像与千问部署

本说明用于把源码上传 GitHub、由 GitHub Actions 构建 GHCR 镜像，并在服务器运行。API Key 和正式密码不进入仓库，也不进入容器镜像。

## 1. 上传前

1. 如果 API Key 曾出现在聊天、截图、日志或公开文本中，先到阿里云百炼控制台撤销并重新创建。
2. 不要创建或提交 `.env`。仓库只保留 `.env.example`。
3. 不要提交 `data/`、`.local/`、数据库、`master.key` 或视频；这些路径已同时加入 `.gitignore` 与 `.dockerignore`。
4. 推送到 `main` 后，现有工作流会运行测试，并把镜像发布到 `ghcr.io/<GitHub用户名>/<仓库名>:latest`。

## 2. 直接体验

克隆仓库后运行：

```powershell
docker compose up --build -d
```

访问：

- 舞镜智练：`http://服务器地址:8787/wujing`
- 舞安智护：`http://服务器地址:8787/wuan`
- 管理员后台：`http://服务器地址:8787/admin/login`

Compose 默认启用公开演示账号，账号表见 `README-DANCE.md`。这是为了验收方便，不适合直接暴露到公网。

## 3. 正式账号启动

在服务器的部署平台 Secret 或服务器环境变量中设置：

```dotenv
DANCE_DEMO_MODE=0
DANCE_BOOTSTRAP_ACCOUNTS=1
DANCE_ADMIN_PASSWORD=替换为管理员初始密码
DANCE_TEACHER_PASSWORD=替换为教师初始密码
DANCE_STUDENT_PASSWORD=替换为学生初始密码
DANCE_MEDIC_PASSWORD=替换为风险教师初始密码
YANZHI_MASTER_KEY=64位十六进制随机值
YANZHI_SECURE_COOKIE=1
```

首次启动会创建 2 个管理员、3 个教师、6 个学生和 1 个风险复核教师。以后重启不会覆盖已有密码。`YANZHI_MASTER_KEY` 必须稳定保存，否则更换数据卷或密钥后无法解密已保存的模型 API Key。

## 4. 千问视觉智能体

把新生成的 API Key 作为运行时 Secret 注入：

```dotenv
DASHSCOPE_API_KEY=新的千问APIKey
QWEN_BASE_URL=https://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
QWEN_VISION_MODEL=qwen3-vl-plus
```

如果暂时不知道 WorkspaceId，可使用兼容旧地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`；阿里云仍支持该地址，但建议使用百炼控制台显示的专属 API Host。API Key 与 API Host 必须属于同一地域。

服务启动后会自动完成以下工作：

1. 在服务端创建或复用“千问视觉（环境变量）”模型配置。
2. 用主密钥加密保存 API Key；接口和前端只会看到末四位。
3. 本机 MediaPipe 先提取 33 点骨架和膝角、躯干角、肩线等几何指标。
4. 学生单独同意云端分析后，最多 6 张遮挡面部并叠加骨架线的关键帧、教师标准和角度指标才会发送给千问。
5. 千问输出动作标准合规预判与证据，教师审核后才能发布给学生。

千问预判只表示“是否符合教师发布的动作标准”，不能替代教师判断、医疗诊断或损伤风险评估。

## 5. 使用已发布的 GHCR 镜像

在服务器设置 `WUDA_IMAGE` 后启动 Compose：

```powershell
$env:WUDA_IMAGE = "ghcr.io/你的GitHub用户名/你的仓库名:latest"
docker compose pull
docker compose up -d --no-build
```

环境变量仍在服务器或部署平台配置，不能在构建 GitHub 镜像时写入 API Key。镜像可公开复用，密钥只属于具体运行实例。
