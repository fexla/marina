由于软件需求书和你对代码的理解不完全准确，导致目前这个和程序没有按照我的要求完成

> **历史档案**:本文件创建于 alpha 阶段,产品当时叫 EasyTerm,自 v1.5 起更名为 Marina(见软件定义书 ADR-012)。下文 "EasyTerm" 字样保留作为时间点快照。

第一个问题就是：你对持有的理解不正确，只有窗口当时正在显示的才是真正的持有，一个窗口只能只有一个终端，点击其他标签页的时候释放现在的并且持有另外一个，一个终端只能被一个窗口持有，一刻窗口只能持有一个终端

窗口关闭后，重新打开的时候，历史显示内容没有渲染出来

终端的滚动条区域没有正确适配主题

目前主题是默认Rose Pine，没有实现切换，点击切换的时候没有反应

然后最好是新增Ubuntu和windows terminal主题

然后默认标题不要是shell，要是是bash就是bash Powershell就是Powershell

临时分类目前无法有效测试，暂时不测试，后面实现右键菜单之后才开始测试



经过一轮修正之后，最明显的一些问题已经解决了，但是还有其他问题

第一个问题就是目前选择不同的标签页，会导致标签页本身的位置移动。就是假设有两个标签页，然后会这样：点击右边的额标签页，回导致右边的标签页移动到左边，这是不可接受的

目前的视觉效果是，无论我点选哪一个标签页，被选中的始终是左边的第一个

标签页的逻辑应该是，被其他窗口持有，本窗口不能显示的标签页，灰色显示到最右边

第二个问题就是，关闭窗口再打开的时候，第一行的Windows Powershell会重复，如下所示
Windows PowerShell
WindowsPowerShell
Windows PowerShell
Windows PowerShell
Windows PowerShell
Windows PowerShell
Windows PowerShell
Windows PowerShell
版权所有(C)Microsoft Corporation。保留所有权利。
安装最新的 PowerShell，了解新功能和改进!https://aka.ms/PSWindows
PS E:\projects\dashboard\cutie> dummdumm:无法将“dumm”项识别为 cmdlet、函数、脚本文件或可运行程序的名禾确，然后再试一次。
所在位置 行:1字符:1
dumm
NN
ObjectNotFound: (dumm:String) [], ComFullyQualifiedErrorId:CommandNotFoundException
CategoryInfo
PS E:\projects\dashboard\cutie>

下一个问题是，有的时候“孤儿”页面或者说接管页面出现或者闪烁，应该说，你根本就不应该设计这个页面，交互逻辑中没有这一项，要是所有标签页全部都灰显，这个窗口应该做的事情是显示新建终端页面，你反思一下是不是这样
