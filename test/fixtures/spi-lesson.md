# SPI 时钟分频踩坑

XR-100 上电后 CTRL_REG 复位值是 0x00，此时 SPI 时钟不分频，外接 Flash 会读错。
初始化时要先把 CTRL_REG 写成 0x03（4 分频），再访问外设。
