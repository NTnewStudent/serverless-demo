#描述
使用COS+云函数+ASR+CFS（可选），快速构建音视频转码服务；凭借 ffmpeg，还可以扩展支持自定义的转码能力。支持结果回调(可选)。

##注意事项
1. 本示例需要在环境变量配置COS的bucket信息，并设置COS触发器或者API网关触发器配合使用；
2. 另外在函数配置中会使用运行角色来操作COS资源，需要确保有cos bucket的对象上传权限；
3. 源文件所在bucket需要设置为公有读私有写。


##回调使用方式
回调是可选的。如果要使用回调，则需在环境变量中添加`callback_url`。
执行的结果会自动回调到该URL上。