设置页面的滚动条没有正确使用主题

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。


移除跟随系统主题功能，不可靠

字体选择改成显示所有已安装字体，然后也需要一些专门的推荐字体

字体选择器的箭头有主题泄露问题

有的时候终端的状态会卡在活跃

由于目前还不打算打包，开机启动暂未测试

按ctrl+f没有弹出搜索栏，而是出现这个现象

PS E:\projects\dashboard\cutie> ^F

搜索框没有命中数目，但是终端搜索实际上是可以用的

终端搜索的组合键有时候不稳定。按动enter也是上一个

Esc按动不可靠

粘贴多行的时候没有警告

不要什么都用Emoji，搞个真正的图标库



导入数据后无法正常渲染，重启恢复

Electron Security Warning (Insecure Content-Security-Policy) This renderer process has either no Content Security
  Policy set or a policy with "unsafe-eval" enabled. This exposes users of
  this app to unnecessary security risks.

For more information and help, consult
https://electronjs.org/docs/tutorial/security.
This warning will not show up
once the app is packaged.
warnAboutInsecureCSP @ VM112 renderer_init:2
