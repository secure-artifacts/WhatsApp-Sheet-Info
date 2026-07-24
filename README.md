# WhatsApp Sheet Info

Chrome/Edge Manifest V3 插件：根据 WhatsApp Web 当前聊天号码，在指定的 Google Sheet 子表中查询并显示对应列；支持侧板结果、列表标签、名字颜色与关注号码。

> 本仓库已按**公开开源**方式脱敏：不含你的 OAuth 客户端、扩展私钥、真实表格 ID 或关注号码。  
> 表格链接、关注名单、登录状态只保存在本机 `chrome.storage`，不会随代码提交。  
>
> **分发建议：** GitHub 保持占位符；给熟人用时，在**本地**填好 `client_id`（可选固定 `key`）后，把整个插件文件夹/压缩包发给对方加载即可，无需改代码。切勿把含真实 `client_id` 的版本 commit 回公开仓库。

## 功能概览

- 按当前 WhatsApp 联系人号码查询 Google Sheet  
- 多表格 / 多子表按顺序搜索  
- 结果列展示、可编辑列写回（需 Google 登录）  
- 气泡标签 + 名字颜色（关键词包含匹配）  
- 关注号码：保存名单、查询新增、全部重查  

## 安装（开发者模式）

1. 克隆本仓库。  
2. 按下方说明配置 Google OAuth（编辑私有表 / 写回单元格需要）。  
3. 打开 `chrome://extensions`（Edge：`edge://extensions`），启用「开发者模式」。  
4. 「加载已解压的扩展程序」，选择本目录。  
5. 打开 [WhatsApp Web](https://web.whatsapp.com)，点击扩展图标打开侧板。  

公开只读表格：在 Google Sheet「共享」中设为「知道链接的任何人可查看」，可不登录 Google。  
编辑单元格或读取非公开表：需登录，且账号对表格有相应权限。

## 配置 Google OAuth（公开仓库必做）

扩展使用 Chrome Identity + Google Sheets API。开源版 `manifest.json` 中的 `oauth2.client_id` 为占位符，需换成你自己的。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) 创建或选择项目。  
2. 启用 **Google Sheets API**。  
3. 「API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID」  
   - 应用类型选 **Chrome 扩展程序**  
   - 扩展程序 ID：先用占位加载扩展一次，在 `chrome://extensions` 复制 ID，填回凭据并保存  
4. 把生成的客户端 ID 写入 `manifest.json`：

```json
"oauth2": {
  "client_id": "xxxxxxxx.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/spreadsheets"]
}
```

5. 在 `chrome://extensions` 点击本扩展的「重新加载」。  

可选：若需要**固定扩展 ID**（方便 OAuth 回调），可用 `openssl` 生成密钥对，将公钥写入 `manifest.json` 的 `"key"` 字段；**私钥（.pem）切勿提交到 Git**（已在 `.gitignore`）。

## 使用说明

顶部三个页签：

| 页签 | 作用 |
|------|------|
| **查询结果** | 当前联系人信息 |
| **关注号码** | 名单 + 查询新增 / 全部重查 |
| **表格设置** | Google 登录与表格/列配置 |

### 表格设置

每个表格可填写：

- **备注名称**（可选）  
- **表格链接或 ID**  
- **子表名称**（每行一个，按顺序搜索）  
- **号码列**（如 `AA`）  
- **结果列**（如 `D=客户等级`）  
- **可编辑列**（可选，须在结果列中）  
- **气泡标签列**（建议 1 列，如 `D`）  
- **名字颜色列**（可选，如 `BH`，只改名字颜色）  
- **气泡标签位置**：信息栏 / 名字后面  
- **颜色规则**：关键词包含匹配；给名字颜色的规则请填列名（如 `BH`）  

**保存配置**：只保存设置，不自动查关注号码。

### 关注号码

- **保存名单**：只存号码  
- **查询新增**：只查尚未匹配的新号码  
- **全部重查**：清缓存后重查全部关注号码  

号码比较会忽略 `+`、空格、括号、短横线；科特迪瓦号码兼容 2021 年前后格式。

### 其他

- 表格索引缓存约 5 分钟（本地）；点侧板 `↻` 刷新**当前联系人**结果  
- 关注名单后台约每 2 分钟轻量刷新（有缓存则几乎不联网）  
- 更新代码后：扩展页「重新加载」+ 刷新 WhatsApp Web  

## 自检

```bash
node test.mjs
```

## 请勿提交

- Google OAuth 客户端密钥（若有）  
- 扩展私钥 `*.pem`  
- 含真实表格 ID / 关注号码的本地配置  
- 打包产物 `*.crx` / `*.zip`  

用户数据仅在本机扩展存储中，不在本仓库。

## License

按你的需要自行补充许可证文件（如 MIT）。
