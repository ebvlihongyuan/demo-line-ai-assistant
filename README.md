# 示范线 AI 智能助手

化工知识与传感器问答助手，支持在 Windows 本机维护 Word、PDF 和 Excel 知识库。本机找到资料时显示原文和来源，不发送资料给模型；找不到或知识库不可用时，只有用户本次明确同意才发送当前问题。

Windows 版的安装、更新、DeepSeek 配置、知识库路径和隐私限制，请阅读 [Windows 本机知识库使用说明](docs/Windows本机知识库使用说明.md)。

开发命令：`pnpm dev`；类型检查与测试：`pnpm check`、`pnpm test`；构建和启动：`pnpm build`、`pnpm start`。默认端口 3000，可在运行环境或 `.env` 中设置 `PORT`。

企业网页嵌入说明见 [企业网站嵌入指南](docs/enterprise-embed.md)。Windows 本机知识库服务仅允许本机访问且禁止 iframe 嵌入；云端嵌入页不能读取用户电脑上的 D 盘。
