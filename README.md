# 舞蹈教学智能体：舞镜智练 × 舞安智护

本项目用于舞蹈教学，不是智学或旧版数字教研平台。

- 舞镜智练：教师发布规范动作与示范参考，学生上传练习并提取动态骨架，授权后调用千问，教师复核反馈。
- 舞安智护：训练状态与负荷记录，按职责授权查看；不提供医学诊断。
- 视频上限 100 MB、90 秒，有效帧门槛 70%。教师示范与学生本轮分析均可预览动态骨架。

## Windows CMD 本机演示

安装 Node.js 22.13 或更新版本，在项目目录运行：

```bat
npm run setup:pose
npm run init:dance
npm start
```

舞镜智练：http://127.0.0.1:8790/wujing  
舞安智护：http://127.0.0.1:8790/wuan  
管理后台：http://127.0.0.1:8790/admin

本机账号：`dance_teacher`、`dance_student`、`dance_medic`、`dance_admin`，密码均为 `12345678`。仅限本机演示，不用于公网。

## GitHub 自动镜像

推送 main 后，Actions 自动测试、构建、容器冒烟验证，再发布：

```text
ghcr.io/bjwlxyzhuzhu/wudao:latest
```

```bash
docker compose pull
docker compose up -d
```

容器端口 8787，持久化目录 /app/data。镜像默认展示舞蹈平台，旧教研页面不开放。Compose 演示账号不同于本机账号，参见 [舞蹈说明](README-DANCE.md)。正式部署须关闭演示账号并设置强密码。

千问密钥通过管理后台或运行环境 DASHSCOPE_API_KEY 配置，不写入源码与镜像。本机数据、视频、报名表、录屏均不上传。

[部署指南](DEPLOY-GITHUB.md) · [账号与操作手册](docs/账号密码与操作手册.md)

仓库保留舞蹈平台依赖的共享认证、模型配置和管理后端，未删除共享代码以免破坏现有账号与数据。
