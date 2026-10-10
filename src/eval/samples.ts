/**
 * 纯合成留出集的作者数据（#12 HITL 决定：YG 2026-10-08 拍板「纯合成」）。
 *
 * 全部句子为本票新撰，不来自任何既有文档或语料（与旧 120 条开发集天然不跨集）。
 * 池化设计：outside/inside 池刻意超额，构建器用真实词库逐一校验后择优入集，
 * 未入集个体连同其真实标签写进构建报告。目标词不得出现在上文里（构建器断言）。
 */

export type Dimension =
  | "outside-complete"
  | "beyond-page"
  | "homophone"
  | "long-pinyin"
  | "empty-context"
  | "long-short-text"
  | "boundary";

export interface DraftSample {
  readonly id: string;
  readonly dimension: Dimension;
  readonly precedingText: string;
  readonly pinyin: string;
  readonly target?: string;
  readonly homophonePair?: string;
}

/** 候选外池（超额 ~44，构建器按词库校验择优 36 入集）。 */
export const OUTSIDE_POOL: readonly DraftSample[] = [
  { id: "out-001", dimension: "outside-complete", precedingText: "电台深夜放的那支", pinyin: "lange", target: "澜歌" },
  { id: "out-002", dimension: "outside-complete", precedingText: "剧组新戏的取景地定在", pinyin: "xinglan", target: "星阑" },
  { id: "out-003", dimension: "outside-complete", precedingText: "传说中最神秘的那座", pinyin: "wuyincheng", target: "雾隐城" },
  { id: "out-004", dimension: "outside-complete", precedingText: "新下水的科考船名为", pinyin: "zhuguanghao", target: "逐光号" },
  { id: "out-005", dimension: "outside-complete", precedingText: "护林员说林间特有的那种鸟叫", pinyin: "huiyuniao", target: "灰羽鸟" },
  { id: "out-006", dimension: "outside-complete", precedingText: "老地图上标注着一条", pinyin: "yinghuojie", target: "萤火街" },
  { id: "out-007", dimension: "outside-complete", precedingText: "沿着铁轨走到尽头是一座小", pinyin: "qidizhen", target: "汽笛镇" },
  { id: "out-008", dimension: "outside-complete", precedingText: "大学里最活跃的社团是", pinyin: "zhiyuanshe", target: "纸鸢社" },
  { id: "out-009", dimension: "outside-complete", precedingText: "港口老塔楼里藏着一座", pinyin: "chaoxizhong", target: "潮汐钟" },
  { id: "out-010", dimension: "outside-complete", precedingText: "航拍镜头缓缓掠过一片", pinyin: "mailangwan", target: "麦浪湾" },
  { id: "out-011", dimension: "outside-complete", precedingText: "导游说前方的山谷名叫", pinyin: "quemingjian", target: "雀鸣涧" },
  { id: "out-012", dimension: "outside-complete", precedingText: "矿区改造后小镇更名为", pinyin: "tongjuezhen", target: "铜蕨镇" },
  { id: "out-013", dimension: "outside-complete", precedingText: "地图边角上印着一片冰封的", pinyin: "shuangjianghu", target: "霜降湖" },
  { id: "out-014", dimension: "outside-complete", precedingText: "游轮在晨雾里停靠", pinyin: "lanjingwan", target: "蓝鲸湾" },
  { id: "out-015", dimension: "outside-complete", precedingText: "村里的老人都管他叫", pinyin: "zhuiyunzhe", target: "追云者" },
  { id: "out-016", dimension: "outside-complete", precedingText: "她的新随笔集定名为", pinyin: "shiguangji", target: "拾光记" },
  { id: "out-017", dimension: "outside-complete", precedingText: "校园话剧团有个别名叫", pinyin: "randongshe", target: "燃冬社" },
  { id: "out-018", dimension: "outside-complete", precedingText: "甘肃老乡带来一壶自酿的", pinyin: "tianpeijiu", target: "甜醅酒" },
  { id: "out-019", dimension: "outside-complete", precedingText: "茶艺师给客人换了一只", pinyin: "yanchazhan", target: "岩茶盏" },
  { id: "out-020", dimension: "outside-complete", precedingText: "诗里反复出现的那座楼叫", pinyin: "heguilou", target: "鹤归楼" },
  { id: "out-021", dimension: "outside-complete", precedingText: "冬季摄影基地最终选在", pinyin: "wusongzhen", target: "雾凇镇" },
  { id: "out-022", dimension: "outside-complete", precedingText: "新交付的小区取名叫", pinyin: "jingzheli", target: "惊蛰里" },
  { id: "out-023", dimension: "outside-complete", precedingText: "老宅就坐落在一条安静的", pinyin: "mujinxiang", target: "木槿巷" },
  { id: "out-024", dimension: "outside-complete", precedingText: "冬日清晨，屋檐下垂着一排", pinyin: "bingyandeng", target: "冰檐灯" },
  { id: "out-025", dimension: "outside-complete", precedingText: "正厅匾额上题着四个字", pinyin: "yanhuanchao", target: "雁还巢" },
  { id: "out-026", dimension: "outside-complete", precedingText: "装备清单里特意列了一双", pinyin: "suxixie", target: "溯溪鞋" },
  { id: "out-027", dimension: "outside-complete", precedingText: "公交报站的下一站是", pinyin: "lanshandao", target: "岚山道" },
  { id: "out-028", dimension: "outside-complete", precedingText: "渡口的旧木牌上写着", pinyin: "tinglandu", target: "汀兰渡" },
  { id: "out-029", dimension: "outside-complete", precedingText: "奶奶用旧布缝了一只", pinyin: "purongzhen", target: "蒲绒枕" },
  { id: "out-030", dimension: "outside-complete", precedingText: "展柜正中摆着一只罕见的", pinyin: "jiqingci", target: "霁青瓷" },
  { id: "out-031", dimension: "outside-complete", precedingText: "公园的最高处有一座", pinyin: "jusongtai", target: "橘颂台" },
  { id: "out-032", dimension: "outside-complete", precedingText: "古城的北门被称作", pinyin: "xuanniaomen", target: "玄鸟门" },
  { id: "out-033", dimension: "outside-complete", precedingText: "夏令营的营地扎在", pinyin: "weidiwan", target: "苇笛湾" },
  { id: "out-034", dimension: "outside-complete", precedingText: "深水区忽然游过一群", pinyin: "yinlinyu", target: "银鳞鱼" },
  { id: "out-035", dimension: "outside-complete", precedingText: "山脚下那家民宿的招牌写着", pinyin: "songguowu", target: "松果屋" },
  { id: "out-036", dimension: "outside-complete", precedingText: "冬夜里最馋的就是那一口", pinyin: "nilubao", target: "泥炉煲" },
  { id: "out-037", dimension: "outside-complete", precedingText: "清晨的集市被当地人唤作", pinyin: "lushuiji", target: "露水集" },
  { id: "out-038", dimension: "outside-complete", precedingText: "退潮之后滩涂上露出一片", pinyin: "xingzitan", target: "星子滩" },
  { id: "out-039", dimension: "outside-complete", precedingText: "茶农说明前采下的叫", pinyin: "xueyacha", target: "雪芽茶" },
  { id: "out-040", dimension: "outside-complete", precedingText: "渔歌里唱的那处海蚀洞叫", pinyin: "chaoyindong", target: "潮音洞" },
  { id: "out-041", dimension: "outside-complete", precedingText: "徒步路线的终点是一片", pinyin: "yemeigu", target: "野莓谷" },
  { id: "out-042", dimension: "outside-complete", precedingText: "篝火晚会上大家唱起古老的", pinyin: "gouhuoyao", target: "篝火谣" },
];

/** 翻页池（目标在完整集合内但位次在第 5 页之后；构建器按两库真实位次择优 24 入集）。 */
export const BEYOND_PAGE_POOL: readonly DraftSample[] = [
  { id: "pg-001", dimension: "beyond-page", precedingText: "实验室月底要采购一批", pinyin: "shiji", target: "试剂" },
  { id: "pg-002", dimension: "beyond-page", precedingText: "古镇的周末", pinyin: "shiji", target: "市集" },
  { id: "pg-003", dimension: "beyond-page", precedingText: "讣告确认了老先生的", pinyin: "shishi", target: "逝世" },
  { id: "pg-004", dimension: "beyond-page", precedingText: "这片战场古时紧邻", pinyin: "jingji", target: "京畿" },
  { id: "pg-005", dimension: "beyond-page", precedingText: "戏班里负责板眼的是", pinyin: "gushi", target: "鼓师" },
  { id: "pg-006", dimension: "beyond-page", precedingText: "登上山顶顿觉", pinyin: "yi", target: "怡" },
  { id: "pg-007", dimension: "beyond-page", precedingText: "形容溃败用成语狼奔", pinyin: "shi", target: "豕" },
  { id: "pg-008", dimension: "beyond-page", precedingText: "他晚年常自比伏枥的老", pinyin: "ji", target: "骥" },
  { id: "pg-009", dimension: "beyond-page", precedingText: "浅滩上站着一只白", pinyin: "lu", target: "鹭" },
  { id: "pg-010", dimension: "beyond-page", precedingText: "池水里长满了绿", pinyin: "zao", target: "藻" },
  { id: "pg-011", dimension: "beyond-page", precedingText: "江心孤悬着一座小", pinyin: "yu", target: "屿" },
  { id: "pg-012", dimension: "beyond-page", precedingText: "水畔有一片亭台楼", pinyin: "xie", target: "榭" },
  { id: "pg-013", dimension: "beyond-page", precedingText: "屋后辟了一方菜", pinyin: "pu", target: "圃" },
  { id: "pg-014", dimension: "beyond-page", precedingText: "他的到访在学界掀起狂", pinyin: "lan", target: "澜" },
  { id: "pg-015", dimension: "beyond-page", precedingText: "凭窗远望层峦叠", pinyin: "zhang", target: "嶂" },
  { id: "pg-016", dimension: "beyond-page", precedingText: "他并非气量狭", pinyin: "ai", target: "隘" },
  { id: "pg-017", dimension: "beyond-page", precedingText: "这种复合材料的特性是坚", pinyin: "ren", target: "韧" },
  { id: "pg-018", dimension: "beyond-page", precedingText: "月下竹林格外清", pinyin: "you", target: "幽" },
  { id: "pg-019", dimension: "beyond-page", precedingText: "古迹里保存着一座衣冠", pinyin: "zhong", target: "冢" },
  { id: "pg-020", dimension: "beyond-page", precedingText: "老城只剩断壁残", pinyin: "yuan", target: "垣" },
  { id: "pg-021", dimension: "beyond-page", precedingText: "走累了想寻个地方小", pinyin: "qi", target: "憩" },
  { id: "pg-022", dimension: "beyond-page", precedingText: "黄土高原千沟万", pinyin: "he", target: "壑" },
  { id: "pg-023", dimension: "beyond-page", precedingText: "古寺坐落在山", pinyin: "lu", target: "麓" },
  { id: "pg-024", dimension: "beyond-page", precedingText: "这条路两旁长满荆", pinyin: "ji", target: "棘" },
];

/** 同音对（同 pinyin 不同目标，语境消歧；12 例 6 对）。 */
export const HOMOPHONE_SAMPLES: readonly DraftSample[] = [
  { id: "hm-001a", dimension: "homophone", homophonePair: "baozi", precedingText: "午饭想吃热乎的", pinyin: "baozi", target: "包子" },
  { id: "hm-001b", dimension: "homophone", homophonePair: "baozi", precedingText: "显微镜下能看到真菌释放的", pinyin: "baozi", target: "孢子" },
  { id: "hm-002a", dimension: "homophone", homophonePair: "shili", precedingText: "这支战队经过补强，整体", pinyin: "shili", target: "实力" },
  { id: "hm-002b", dimension: "homophone", homophonePair: "shili", precedingText: "警方调查发现当地盘踞着一股黑", pinyin: "shili", target: "势力" },
  { id: "hm-003a", dimension: "homophone", homophonePair: "zhili", precedingText: "这道开放题很考验孩子的", pinyin: "zhili", target: "智力" },
  { id: "hm-003b", dimension: "homophone", homophonePair: "zhili", precedingText: "人类从四肢爬行进化到", pinyin: "zhili", target: "直立" },
  { id: "hm-004a", dimension: "homophone", homophonePair: "jihua", precedingText: "项目组下周提交年度", pinyin: "jihua", target: "计划" },
  { id: "hm-004b", dimension: "homophone", homophonePair: "jihua", precedingText: "调解失败反而让矛盾进一步", pinyin: "jihua", target: "激化" },
  { id: "hm-005a", dimension: "homophone", homophonePair: "quanli", precedingText: "制度设计首先要防止滥用公", pinyin: "quanli", target: "权力" },
  { id: "hm-005b", dimension: "homophone", homophonePair: "quanli", precedingText: "救援队正在", pinyin: "quanli", target: "全力" },
  { id: "hm-006a", dimension: "homophone", homophonePair: "gongshi", precedingText: "物理考试要牢记每个", pinyin: "gongshi", target: "公式" },
  { id: "hm-006b", dimension: "homophone", homophonePair: "gongshi", precedingText: "下班之后就不谈", pinyin: "gongshi", target: "公事" },
];

/** 长拼音（4-6 音节）。 */
export const LONG_PINYIN_SAMPLES: readonly DraftSample[] = [
  { id: "lp-001", dimension: "long-pinyin", precedingText: "远航那天海面正好", pinyin: "yifanfengshun", target: "一帆风顺" },
  { id: "lp-002", dimension: "long-pinyin", precedingText: "他讲故事总爱", pinyin: "huashetianzu", target: "画蛇添足" },
  { id: "lp-003", dimension: "long-pinyin", precedingText: "他嘴上训人，行为却常常", pinyin: "zixiangmaodun", target: "自相矛盾" },
  { id: "lp-004", dimension: "long-pinyin", precedingText: "她提醒他别等到", pinyin: "wangyangbulao", target: "亡羊补牢" },
  { id: "lp-005", dimension: "long-pinyin", precedingText: "这种等运气的心态就是", pinyin: "shouzhudaitu", target: "守株待兔" },
  { id: "lp-006", dimension: "long-pinyin", precedingText: "他提的意见算是", pinyin: "paozhuanyinyu", target: "抛砖引玉" },
  { id: "lp-007", dimension: "long-pinyin", precedingText: "大雪封山那夜，邻里都来相助，真是", pinyin: "xuezhongsongtan", target: "雪中送炭" },
  { id: "lp-008", dimension: "long-pinyin", precedingText: "坐在井底看天，不过是", pinyin: "jingdizhiwa", target: "井底之蛙" },
];

/** 可确认空上文。 */
export const EMPTY_CONTEXT_SAMPLES: readonly DraftSample[] = [
  { id: "ec-001", dimension: "empty-context", precedingText: "", pinyin: "nihao", target: "你好" },
  { id: "ec-002", dimension: "empty-context", precedingText: "", pinyin: "xiexie", target: "谢谢" },
  { id: "ec-003", dimension: "empty-context", precedingText: "", pinyin: "zaijian", target: "再见" },
  { id: "ec-004", dimension: "empty-context", precedingText: "", pinyin: "wanan", target: "晚安" },
  { id: "ec-005", dimension: "empty-context", precedingText: "", pinyin: "zaoshanghao", target: "早上好" },
  { id: "ec-006", dimension: "empty-context", precedingText: "", pinyin: "buyongxie", target: "不用谢" },
  { id: "ec-007", dimension: "empty-context", precedingText: "", pinyin: "xinkule", target: "辛苦了" },
  { id: "ec-008", dimension: "empty-context", precedingText: "", pinyin: "qing", target: "请" },
];

/** 长短句与短文（上文 40-300 字符）。 */
export const LONG_SHORT_TEXT_SAMPLES: readonly DraftSample[] = [
  {
    id: "ls-001", dimension: "long-short-text",
    precedingText: "上周的例会开得很长，从产品路线一直讨论到服务部署的细节，中间只休息了一次。散会时天已经黑了，大家收拾东西陆续离开，只有主管还留在座位上整理纪要。我问他要不要帮忙，他摆摆手说",
    pinyin: "mingtianzaishuo",
    target: "明天再说",
  },
  { id: "ls-002", dimension: "long-short-text", precedingText: "天气预报说冷空气明晚抵达，气温会骤降十度左右。提醒家里老人添衣，也把阳台上的绿植搬进屋。出门前我又检查了一遍门窗，才算安心。这种换季时节最需要当心", pinyin: "ganmao", target: "感冒" },
  { id: "ls-003", dimension: "long-short-text", precedingText: "古镇保护方案公示之后，居民的意见分成了两派。一派认为商业开发会冲淡原有的烟火气，另一派则指望客流带动生意。听证会上双方轮流发言，主持人的笔在本子上记满了正反两栏。最后的折中方案保留了原住民比例的下限，同时给新业态划定区域。这件事让我明白，任何改造都要先谈", pinyin: "shenghuo", target: "生活" },
  { id: "ls-004", dimension: "long-short-text", precedingText: "山里的信号时有时无，进村前记得把离线地图下好。合作社的仓库在村口第二家，门口挂着蓝布帘。老板娘说话干脆，报价也实在，谈妥之后她烧了一壶热茶，让我们坐着慢慢核对清单。临走时她塞给我们一袋自家的核桃，说是路上垫肚子。回程的路沿着溪水走，风景很好，只是天色渐晚，需要加", pinyin: "xiaoxin", target: "小心" },
  { id: "ls-005", dimension: "long-short-text", precedingText: "新来的实习生做事很有条理，每天到岗先列当日的任务清单，完成一项划掉一项。遇到不确定的地方，他会把问题记在便签上，攒到固定时间集中来问，而不是随时打断别人。三个月试用期满，团队一致同意留下他，导师给他的评语只有七个字：踏实、肯问、敢", pinyin: "dandang", target: "担当" },
  { id: "ls-006", dimension: "long-short-text", precedingText: "这本菜谱翻得快散架了，最喜欢的是那道炖菜：先把肉块煸出油，加姜片和葱段爆香，再下切块的萝卜，添水没过食材，小火慢炖一个钟头。出锅前撒一把青蒜末，满屋都是香气。冬天做这一锅，配米饭能吃两碗。周末我打算照着做一次，先列好采购单，记得买", pinyin: "wuhuarou", target: "五花肉" },
  { id: "ls-007", dimension: "long-short-text", precedingText: "图书馆四楼靠窗的位置最难抢，早上九点刚开门就有人占座。管理员后来想了个办法，实行预约制，每小时清一次空座。实施一个月，投诉少了一半，上座率反而升了。制度设计的巧思往往比苦口婆心的劝说更有", pinyin: "xiaoli", target: "效力" },
  { id: "ls-008", dimension: "long-short-text", precedingText: "晚班的地铁总是拥挤，车厢里挤满了下班的人。有人闭目养神，有人低声通话，更多的人盯着手机屏幕。到站提示音响起，人流涌向车门，又在下一批乘客涌入时重新填满缝隙。城市就这样日复一日地呼吸着，把千万人的生活运往各自的", pinyin: "mudidi", target: "目的地" },
];

/** 支持边界（协议层必须拒绝、不发请求、安全留空）。 */
export const BOUNDARY_SAMPLES: readonly { id: string; pinyin: string }[] = [
  { id: "bd-001", pinyin: "nh" },
  { id: "bd-002", pinyin: "nihaom" },
  { id: "bd-003", pinyin: "nihaoPython" },
  { id: "bd-004", pinyin: "hello123" },
  { id: "bd-005", pinyin: "w" },
  { id: "bd-006", pinyin: "xx" },
];

export const ALL_DRAFT_SAMPLES: readonly DraftSample[] = [
  ...OUTSIDE_POOL,
  ...BEYOND_PAGE_POOL,
  ...HOMOPHONE_SAMPLES,
  ...LONG_PINYIN_SAMPLES,
  ...EMPTY_CONTEXT_SAMPLES,
  ...LONG_SHORT_TEXT_SAMPLES,
];
