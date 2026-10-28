# "不丢弃"不等于"平坦无限重试"

适用对象:某些事件**绝不能被丢弃**(例如与法定义务、资金、隐私擦除相关),注册时给它们开了
`never_dead_letter` 之类的开关,让它们跳过"重试 N 次后进死信"的判定。

## 开关表达了什么,没表达什么

这个开关把两个正交需求揉成了一个:

| 需求 | 是否被开关表达 |
| --- | --- |
| 绝不能丢弃 | 是(对,必须保留) |
| 失败后以固定间隔永远重放、行上不留任何痕迹、没人被叫醒 | **否,但这是关掉判死之后的默认行为——缺陷本体** |

结果:一个卡死的合规事件每个可见性超时就重放一次,热循环;行上没有失败原因、次数、时间;没有任何告警
以它为 key。"哪些事件卡住了"在 SQL 里都查不出来。

## 配套设施:凡不丢弃,必须同时有这四样

1. **失败记录**:消费侧失败写到事件行(失败次数、最近错误类型、最近失败时间),而不是只打日志。
   错误记录必须在**独立事务**里写(原事务已因异常回滚),并且记录失败本身不得抛出、不得把异常消息或连接串写进日志。
2. **指数退避**:按行上的尝试次数递增延迟(带上限),不依赖队列自己的读取计数。
3. **parked 状态**:连续失败超过阈值(示例值)后进入 `parked`——仍会被重试/可人工重放,但状态可被查询。
   `parked` **不是** `dead_letter`:死信意味着停止重试,对法定义务等同于丢弃。写 `parked` 的代码路径
   不得有任何分支写 `dead_letter`。
4. **可观测**:`parked_count`、`oldest_parked_age_seconds` 进入指标投影,告警以**状态/年龄**为 key,
   而不是以某条日志为 key。

### 退避只给"不丢弃"的事件

退避常见实现是"归档 + 延迟重发",会让队列的读取计数归零。普通事件正是靠读取计数累积到上限才被判死;
给它们加退避,毒消息就永远判不了死,有界流程变成无界。不丢弃的事件本来就关掉了按次数判死,读取计数归零
没有损失,尝试次数改由事件行上落库的计数承担。**不要把退避放宽到所有事件。**

## parked 与 dead_letter 分开计数

- 对"不丢弃"事件,`dead_letter_count` 恒为 0。若告警写成"死信数 > 0",它**永远不会响**。
- 指标里 `parked_count` 与 `dead_letter_count` 各自独立;看板与告警分别配置。
- 状态机里 `parked` 要进 CHECK 约束/枚举,并有 `parked_at` 之类的时间列,告警才能算"最老的 parked 事件多久了"。

## 告警字段必须在日志/指标索引里声明

告警查询引用的字段(如 `parked_count`、`event_type`、`stage`)必须在日志平台/指标系统的**索引配置**里
声明过为可查询字段;否则查询在运行时直接报错或恒返回空,告警永远处于 error/no-data 而没人发现。
同时:

- 日志里的 `hard_alert=true` 之类"自称告警"的字段,若没有任何规则消费它,就不是告警;
- 告警规则必须带环境/阶段过滤,否则对账工具应拒绝应用;
- 在 CI 里静态读取告警模板,断言:存在以 parked 数量/年龄为阈值的规则、规则含 severity 与环境过滤、
  规则引用的每个字段都在索引声明里。

## 类级测试:枚举全仓所有注册点

本处回归只能拦住"已知注册者再犯一次"。下一个人新增第三个"不丢弃"注册者时,即使完全照抄前两个,也会
得到"不丢但也查不到"的默认行为——在一个新文件里,旧测试碰不到。判据一句话:

> 同一个错误换个文件再犯一次,现有测试拦得住吗?

所以要有一个**类级**测试:

1. 全仓扫描所有 `never_dead_letter=True`(或等价)的注册点,**排除测试文件**(测试会注册一次性事件类型),
   且断言"发现的注册者集合非空"——扫描路径坏了不能变成空集合上的真命题;
2. 对**每一个**注册者,断言上述四样配套设施都存在:失败写行、退避、`parked` 状态在 CHECK 约束里且确有
   代码把行迁入、指标投影含 parked 字段、告警规则以 parked 为 key;
3. 断言 parked 路径从不写 `dead_letter`。

骨架(Node 内置测试,解析 Python 源文件;其它语言用对应的 AST/正则读源码):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('every never_dead_letter registration has backoff + parked alert', () => {
  const regs = findRegistrations({ exclude: /(^|\/)(test_[^/]*\.py|[^/]*\.test\.[a-z]+)$/ });
  assert.ok(regs.length > 0, 'discovery returned nothing: scan path broken');
  for (const reg of regs) {
    assert.ok(recordsFailureOnRow(reg), `${reg.file}: failures only logged, not recorded on the row`);
    assert.ok(usesBackoff(reg), `${reg.file}: flat retry at visibility timeout`);
  }
  assert.ok(parkedAlertRules().length > 0, 'no alert keyed on parked count/age');
});
```

```python
# Python 版本:同样的"全仓枚举 + 逐个断言"
def test_all_never_dead_letter_registrations_are_covered():
    regs = [r for r in scan_registrations(ROOT) if not is_test_file(r.path)]
    assert regs, "discovery returned nothing"
    for r in regs:
        assert r.has_backoff and r.records_failure_on_row, r.path
    assert any(rule.keys_on_parked for rule in load_alert_rules())
```
