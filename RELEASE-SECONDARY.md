# 舞智正姿 源码和部署说明

本版面向中等学校的舞蹈技能学习与体态训练辅助，以保留的周五录屏系统源码为基础。包含舞镜智练和舞安智护。视频角度分析不构成脊柱侧弯诊断或治疗建议。

## Windows 本机运行

安装 Node.js 22.13 或更新的 22.x LTS。解压到普通文件夹，在 CMD 进入目录运行：

```cmd
start-demo.cmd
```

无需 Docker，也无需 npm install。源码 ZIP 附姿态识别模型，GitHub 源码若不含模型，先运行 `node scripts/setup-pose-assets.mjs`。启动前可执行 `npm run verify:pose` 检查模型完整性。

地址：http://127.0.0.1:8792/wujing；风险复核：http://127.0.0.1:8792/wuan；管理后台：http://127.0.0.1:8792/admin。

首次运行自动生成本机测试账号，密码均为 `12345678`：`dance_teacher` 教师、`dance_student` 学生、`dance_medic` 风险复核教师、`dance_admin` 管理员。只适用于本机演示，不覆盖已初始化账号的密码。账号没有自动到期机制，停用前一直有效。数据保存在 `.local/dance-data`，重启后保留。

## 新增账号和教学闭环

1. 管理员登录后台，进入账号管理，点击添加账号，填登录名、姓名、身份、班级编号。可填写至少8位且包含字母和数字的密码，也可留空自动生成。
2. 师生使用同一个班级编号，例如 `dance-a`。不同班级的动作标准和训练记录隔离。无舞蹈权限的旧账号，可点击身份和班级修复。
3. 将临时密码私下交给使用者。教师和学生进入 `/wujing`，风险复核教师进入 `/wuan`；首次登录按提示改密。管理员进入 `/admin`。
4. 教师选择动作和视角，填写教学要求和检查点，上传规范视频，提取骨架参考数据，再确认发布标准。
5. 学生选择已发布动作，上传自己的练习视频并授权教学分析。授权云端分析且配置视觉模型后，系统自动请求千问；未配置、拒绝授权或分析失败时不能视为云端分析成功。
6. 教师查看同班学生的训练报告，核对骨架、学生原片（仅在学生授权保存时可用）和反馈，发布复核意见。风险复核教师处理训练风险提示；出现疼痛或持续体态异常应转人工评估。
7. 重置密码会注销该账号会话，下次登录再次改密。停用立即阻止登录并保留历史记录。改身份或班级会注销会话，历史记录不迁移班级。

## 镜像和网站部署

GitHub Actions 在 main 提交和 v 开头的版本标签上运行完整测试、构建镜像、启动冒烟测试，再发布到 GHCR。固定版本推荐使用 `ghcr.io/bjwlxyzhuzhu/wudao:secondary-20261019`（以 Actions 成功发布为准）。容器监听 8787，持久化挂载 `/app/data`。

```sh
docker compose pull
docker compose up -d
```

compose 默认是体验模式，会创建 admin01/Admin123、teacher01/Teach123、student01/Student123、medic01/Medic123；teacher01、student01、medic01 同属 dance-a。此套与本机 dance_ 开头账号不同，不能混用。

公网部署应在 `.env` 配置 `DANCE_DEMO_MODE=0`、`DANCE_BOOTSTRAP_ACCOUNTS=1`，为 `DANCE_ADMIN_PASSWORD`、`DANCE_TEACHER_PASSWORD`、`DANCE_STUDENT_PASSWORD`、`DANCE_MEDIC_PASSWORD` 设置独立强密码；配置 HTTPS 后设 `YANZHI_SECURE_COOKIE=1`。已有账号不会被环境变量重置；迁移旧演示库要在后台改密或停用旧账号。持久化备份必须同时保留数据库、媒体和 master.key，不能只备份数据库。

千问密钥在管理界面或部署平台环境变量 `DASHSCOPE_API_KEY` 中配置，模型使用支持图像输入的 `QWEN_VISION_MODEL`，`QWEN_BASE_URL` 必须与密钥业务空间匹配。密钥、数据库和个人视频不放进源码包或镜像。上线后用独立师生测试账号验证标准发布、视频提交、云端结果和教师复核，再把实际 HTTPS 地址填入比赛表格。本机127.0.0.1地址不能给异地评委使用。

## 身份认证技术说明

`server/auth.js` 使用 scrypt 保存密码摘要；登录生成不透明会话令牌，数据库只存令牌的 SHA256 摘要。浏览器通过 HttpOnly、SameSite=Strict Cookie 持有令牌；HTTPS 部署开启 Secure。`server/server.js` 分别校验 admin/teacher/dance 会话作用域和首次改密状态。`server/dance/accounts.js` 同步创建 users 和 dance_profiles；`server/dance/service.js` 依据角色和班级检查数据权限。前端从 `/api/dance/me` 获取舞蹈身份，新建账号完成改密后才加载教学数据。API Key 在服务端加密保存，不返回给普通师生。

## 提交范围

此包是干净的可运行源码，不含个人训练数据库、私有师生视频、真实密钥和预制训练结果。首次运行须由教师发布标准。原有本地录屏数据继续保留在原工作目录，不受打包影响。
