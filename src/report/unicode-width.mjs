// 单字符显示宽度，对齐 ccusage 20.0.21 所用 unicode-width 0.2.2 的 UnicodeWidthChar::width（非 CJK 语境）。
//
// 规则（Unicode 17.0 数据）：C0/C1 控制符为 None，ccusage 按 0 计；Default_Ignorable_Code_Point、
// Grapheme_Extend、谚文中声 / 终声字母、非 Prepended_Concatenation_Mark 的 GCB=Prepend 等为 0；
// East_Asian_Width 为 W / F、Emoji_Presentation、Emoji_Modifier 为 2（区域指示符仍为 1）；
// U+115F、U+17A4 为 2，U+17D8 为 3，Ambiguous 按 1，其余为 1。
// 下表由 Unicode 17.0 数据按上述规则生成，并已对全部 1,112,064 个 Unicode 标量值逐一
// 用真实 ccusage 20.0.21 的表格截断行为核对，零差异。表外（含 U+00A0 以上未列出者）宽度为 1。

// 宽度为 0 的码位区间（十六进制，单值或 起-止）
const ZERO = `
ad 300-36f 483-489 591-5bd 5bf 5c1-5c2 5c4-5c5 5c7 605 610-61a 61c 64b-65f 670 6d6-6dc
6df-6e4 6e7-6e8 6ea-6ed 70f 711 730-74a 7a6-7b0 7eb-7f3 7fd 816-819 81b-823 825-827
829-82d 859-85b 890-891 897-89f 8ca-902 93a 93c 941-948 94d 951-957 962-963 981 9bc 9be
9c1-9c4 9cd 9d7 9e2-9e3 9fe a01-a02 a3c a41-a42 a47-a48 a4b-a4d a51 a70-a71 a75 a81-a82
abc ac1-ac5 ac7-ac8 acd ae2-ae3 afa-aff b01 b3c b3e-b3f b41-b44 b4d b55-b57 b62-b63 b82
bbe bc0 bcd bd7 c00 c04 c3c c3e-c40 c46-c48 c4a-c4d c55-c56 c62-c63 c81 cbc cbf-cc0 cc2
cc6-cc8 cca-ccd cd5-cd6 ce2-ce3 d00-d01 d3b-d3c d3e d41-d44 d4d-d4e d57 d62-d63 d81 dca
dcf dd2-dd4 dd6 ddf e31 e34-e3a e47-e4e eb1 eb4-ebc ec8-ece f18-f19 f35 f37 f39 f71-f7e
f80-f84 f86-f87 f8d-f97 f99-fbc fc6 102d-1030 1032-1037 1039-103a 103d-103e 1058-1059
105e-1060 1071-1074 1082 1085-1086 108d 109d 1160-11ff 135d-135f 1712-1715 1732-1734
1752-1753 1772-1773 17b4-17b5 17b7-17bd 17c6 17c9-17d3 17dd 180b-180f 1885-1886 18a9
1920-1922 1927-1928 1932 1939-193b 1a17-1a18 1a1b 1a56 1a58-1a5e 1a60 1a62 1a65-1a6c
1a73-1a7c 1a7f 1ab0-1add 1ae0-1aeb 1b00-1b03 1b34-1b3d 1b42-1b44 1b6b-1b73 1b80-1b81
1ba2-1ba5 1ba8-1bad 1be6 1be8-1be9 1bed 1bef-1bf3 1c2c-1c33 1c36-1c37 1cd0-1cd2
1cd4-1ce0 1ce2-1ce8 1ced 1cf4 1cf8-1cf9 1dc0-1dff 200b-200f 202a-202e 2060-206f
20d0-20f0 2cef-2cf1 2de0-2dff 302a-302f 3099-309a 3164 a66f-a672 a674-a67d a69e-a69f
a6f0-a6f1 a802 a806 a80b a825-a826 a82c a8c4-a8c5 a8e0-a8f1 a8fa a8ff a926-a92d
a947-a951 a953 a980-a982 a9b3 a9b6-a9b9 a9bc-a9bd a9c0 a9e5 aa29-aa2e aa31-aa32
aa35-aa36 aa43 aa4c aa7c aab0 aab2-aab4 aab7-aab8 aabe-aabf aac1 aaec-aaed aaf6 abe5
abe8 abed d7b0-d7c6 d7cb-d7fb fb1e fe00-fe0f fe20-fe2f feff ff9e-ffa0 fff0-fff8 101fd
102e0 10376-1037a 10a01-10a03 10a05-10a06 10a0c-10a0f 10a38-10a3a 10a3f 10ae5-10ae6
10d24-10d27 10d69-10d6d 10eab-10eac 10efa-10eff 10f46-10f50 10f82-10f85 11001
11038-11046 11070 11073-11074 1107f-11081 110b3-110b6 110b9-110ba 110c2 11100-11102
11127-1112b 1112d-11134 11173 11180-11181 111b6-111be 111c0 111c2-111c3 111c9-111cc
111cf 1122f-11231 11234-11237 1123e 11241 112df 112e3-112ea 11300-11301 1133b-1133c
1133e 11340 1134d 11357 11366-1136c 11370-11374 113b8 113bb-113c0 113c2 113c5
113c7-113c9 113ce-113d2 113e1-113e2 11438-1143f 11442-11444 11446 1145e 114b0
114b3-114b8 114ba 114bd 114bf-114c0 114c2-114c3 115af 115b2-115b5 115bc-115bd
115bf-115c0 115dc-115dd 11633-1163a 1163d 1163f-11640 116ab 116ad 116b0-116b7 1171d
1171f 11722-11725 11727-1172b 1182f-11837 11839-1183a 11930 1193b-1193f 11941 11943
119d4-119d7 119da-119db 119e0 11a01-11a0a 11a33-11a38 11a3b-11a3e 11a47 11a51-11a56
11a59-11a5b 11a84-11a96 11a98-11a99 11b60 11b62-11b64 11b66 11c30-11c36 11c38-11c3d
11c3f 11c92-11ca7 11caa-11cb0 11cb2-11cb3 11cb5-11cb6 11d31-11d36 11d3a 11d3c-11d3d
11d3f-11d47 11d90-11d91 11d95 11d97 11ef3-11ef4 11f00-11f02 11f36-11f3a 11f40-11f42
11f5a 13440 13447-13455 1611e-16129 1612d-1612f 16af0-16af4 16b30-16b36 16f4f
16f8f-16f92 16fe4 16ff0-16ff1 1bc9d-1bc9e 1bca0-1bca3 1cf00-1cf2d 1cf30-1cf46
1d165-1d169 1d16d-1d182 1d185-1d18b 1d1aa-1d1ad 1d242-1d244 1da00-1da36 1da3b-1da6c
1da75 1da84 1da9b-1da9f 1daa1-1daaf 1e000-1e006 1e008-1e018 1e01b-1e021 1e023-1e024
1e026-1e02a 1e08f 1e130-1e136 1e2ae 1e2ec-1e2ef 1e4ec-1e4ef 1e5ee-1e5ef 1e6e3 1e6e6
1e6ee-1e6ef 1e6f5 1e8d0-1e8d6 1e944-1e94a e0000-e0fff
`;

// 宽度为 2 的码位区间
const WIDE = `
1100-115f 17a4 231a-231b 2329-232a 23e9-23ec 23f0 23f3 25fd-25fe 2614-2615 2630-2637
2648-2653 267f 268a-268f 2693 26a1 26aa-26ab 26bd-26be 26c4-26c5 26ce 26d4 26ea
26f2-26f3 26f5 26fa 26fd 2705 270a-270b 2728 274c 274e 2753-2755 2757 2795-2797 27b0
27bf 2b1b-2b1c 2b50 2b55 2e80-2e99 2e9b-2ef3 2f00-2fd5 2ff0-3029 3030-303e 3041-3096
309b-30ff 3105-312f 3131-3163 3165-318e 3190-31e5 31ef-321e 3220-3247 3250-a48c
a490-a4c6 a960-a97c ac00-d7a3 f900-faff fe10-fe19 fe30-fe52 fe54-fe66 fe68-fe6b
ff01-ff60 ffe0-ffe6 16fe0-16fe3 16ff2-16ff6 17000-18cd5 18cff-18d1e 18d80-18df2
1aff0-1aff3 1aff5-1affb 1affd-1affe 1b000-1b122 1b132 1b150-1b152 1b155 1b164-1b167
1b170-1b2fb 1d300-1d356 1d360-1d376 1f004 1f0cf 1f18e 1f191-1f19a 1f200-1f202
1f210-1f23b 1f240-1f248 1f250-1f251 1f260-1f265 1f300-1f320 1f32d-1f335 1f337-1f37c
1f37e-1f393 1f3a0-1f3ca 1f3cf-1f3d3 1f3e0-1f3f0 1f3f4 1f3f8-1f43e 1f440 1f442-1f4fc
1f4ff-1f53d 1f54b-1f54e 1f550-1f567 1f57a 1f595-1f596 1f5a4 1f5fb-1f64f 1f680-1f6c5
1f6cc 1f6d0-1f6d2 1f6d5-1f6d8 1f6dc-1f6df 1f6eb-1f6ec 1f6f4-1f6fc 1f7e0-1f7eb 1f7f0
1f90c-1f93a 1f93c-1f945 1f947-1f9ff 1fa70-1fa7c 1fa80-1fa8a 1fa8e-1fac6 1fac8
1facd-1fadc 1fadf-1faea 1faef-1faf8 20000-2fffd 30000-3fffd
`;

// 解析为按起点排序的区间表：[起点, 终点, 宽度]
const ranges = [];
for (const [text, width] of [
  [ZERO, 0],
  [WIDE, 2],
  ['17d8', 3],
]) {
  for (const token of text.trim().split(/\s+/)) {
    const [a, b = a] = token.split('-');
    ranges.push([parseInt(a, 16), parseInt(b, 16), width]);
  }
}
ranges.sort((x, y) => x[0] - y[0]);
const START = Uint32Array.from(ranges, (r) => r[0]);
const END = Uint32Array.from(ranges, (r) => r[1]);
const VALUE = Uint8Array.from(ranges, (r) => r[2]);

/** 单个码位的显示宽度（ccusage 的 char_display_width：width(ch).unwrap_or(0)）。 */
export function charWidth(cp) {
  if (cp < 0x7f) return cp >= 0x20 ? 1 : 0;
  if (cp < 0xa0) return 0;
  let lo = 0;
  let hi = START.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (START[mid] > cp) hi = mid - 1;
    else if (END[mid] < cp) lo = mid + 1;
    else return VALUE[mid];
  }
  return 1;
}
