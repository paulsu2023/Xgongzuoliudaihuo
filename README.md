# AI 电商带货工作流平台

双击 `启动工作台.bat`，浏览器打开 `http://127.0.0.1:4318`。

## 已实现的 V1/P0 流程

1. 项目基础设置：中英 UI、市场与输出语言联动、模型、比例、视频时长。
2. 产品、模特、场景各支持 1–4 张 JPG/PNG/WEBP：添加、预览、删除和替换。
3. 上传的产品图片直接作为视觉依据，生成 Product Reference Sheet；无需先确认产品识别结果。
4. Vertex 图像模型生成 Product / Character / Location Reference Sheet；可放大、下载和重新生成。
5. 基于三张 Sheet 生成每 10 秒一段的带货视频 Prompt，支持单段或全部复制。
6. 登录后，产品、模特、场景图片会保存到本人私有的 Google Cloud 素材库，可在视频策划中直接复用；未登录时项目状态仅保存在本机浏览器。

## Vertex 凭据

本地后端读取 `.env.local` 指向的服务账号文件。凭据不会发送到浏览器，也不会写入本项目。

如果将来要换凭据，在项目根目录创建 `.env.local`，参考 `.env.example` 填写 `VERTEX_SERVICE_ACCOUNT_FILE`。不要提交该文件。

## Vercel 部署

在 Vercel 项目环境变量中设置以下服务端变量：

- `GOOGLE_SERVICE_ACCOUNT_JSON`：完整服务账号 JSON，设为 Sensitive。
- `VERTEX_LOCATION=global`
- `VERTEX_TEXT_MODEL=gemini-3.5-flash`
- `VERTEX_IMAGE_MODEL=gemini-3.1-flash-image`
- `GCS_ASSET_BUCKET=aerial-jigsaw-498805-c0-ai-commerce-assets`
- `IDENTITY_PLATFORM_API_KEY`：Identity Platform 的服务端密钥，设为 Sensitive，绝不使用 `NEXT_PUBLIC_` 或写入浏览器代码。

部署版单次请求需控制在约 4MB 内；浏览器端不保存服务账号。

## 说明

- 默认 Banana 2 映射到 `gemini-3.1-flash-image`；Banana Pro 映射到 `gemini-3-pro-image`。
- 文本分析和视频 Prompt 默认使用 `gemini-3.5-flash`。
- 本地服务只监听 `127.0.0.1`；Vercel 部署会提供 HTTPS 地址。
