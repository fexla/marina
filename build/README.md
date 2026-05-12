# build/ — 打包资源

本目录存放 electron-builder 打包时需要的图标资源。

## 当前文件

- `icon.svg` — 源文件(256×256,Rose Pine 紫底 + Iris 紫 ">_" 提示符 + Gold 光标)。V1.3 / M1-E 引入。

## 生成 .ico / .png(打包前手动一次)

`electron-builder` 需要 `build/icon.ico`(Windows)与 `build/icon.png`(>=512×512,跨平台 fallback)。

### 方案 A:在线工具(零依赖)
1. 用 [realfavicongenerator](https://realfavicongenerator.net) 或 [cloudconvert](https://cloudconvert.com/svg-to-ico) 把 `icon.svg` 转成多尺寸 `icon.ico`(包含 16/24/32/48/64/128/256)。
2. 同一站点导出 `icon.png` (1024×1024)。
3. 把两个文件放回此目录,提交。

### 方案 B:本机 ImageMagick
```bash
# 需要 ImageMagick 7+
magick convert -background none icon.svg -define icon:auto-resize=256,128,64,48,32,24,16 icon.ico
magick convert -background none -resize 1024x1024 icon.svg icon.png
```

### 方案 C:不引入新 npm 依赖的最低限度
electron-builder 接受 PNG 作为 Windows 图标(自动转 .ico),仅需一张 ≥256×256 的 PNG。出一张 PNG 放为 `icon.png`,把 `electron-builder.yml` 的 `win.icon` 指向它即可,跳过 ico 步骤。

## 状态 (2026-05-12)

- `icon.svg` ✅
- `icon.ico` ❌(手动生成后放入)
- `icon.png` ❌(同上)

`electron-builder.yml` 的 `win.icon` 行在 ico/png 都不存在时是注释的;放入后取消注释。
