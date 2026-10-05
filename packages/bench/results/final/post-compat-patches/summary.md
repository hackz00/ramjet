median ms, measured build -> current build (7 runs; news revisit/warm/cold: current has 6 due to one harness EPERM)
| fixture | mode | metric | measured | current | delta |
|---|---|---|---:|---:|---:|
| article | cold | fcp | 324 | 320 | -4 |
| article | cold | load | 438 | 439 | +2 |
| article | warm | fcp | 216 | 216 | -0 |
| article | warm | load | 210 | 211 | +1 |
| article | revisit | fcp | 240 | 244 | +4 |
| article | revisit | load | 237 | 242 | +5 |
| spa | cold | fcp | 128 | 136 | +8 |
| spa | cold | load | 886 | 897 | +11 |
| spa | warm | fcp | 116 | 116 | -0 |
| spa | warm | load | 256 | 252 | -4 |
| spa | revisit | fcp | 124 | 132 | +8 |
| spa | revisit | load | 202 | 206 | +4 |
| css-heavy | cold | fcp | 416 | 412 | -4 |
| css-heavy | cold | load | 403 | 400 | -3 |
| css-heavy | warm | fcp | 212 | 212 | +0 |
| css-heavy | warm | load | 202 | 205 | +2 |
| css-heavy | revisit | fcp | 212 | 216 | +4 |
| css-heavy | revisit | load | 201 | 223 | +21 |
| grid | cold | fcp | 124 | 124 | +0 |
| grid | cold | load | 251 | 254 | +3 |
| grid | warm | fcp | 112 | 108 | -4 |
| grid | warm | load | 214 | 214 | -1 |
| grid | revisit | fcp | 120 | 124 | +4 |
| grid | revisit | load | 232 | 228 | -4 |
| frames | cold | fcp | 132 | 128 | -4 |
| frames | cold | load | 243 | 238 | -4 |
| frames | warm | fcp | 116 | 116 | +0 |
| frames | warm | load | 226 | 226 | +0 |
| frames | revisit | fcp | 124 | 128 | +4 |
| frames | revisit | load | 238 | 245 | +6 |
| news | cold | fcp | 332 | 338 | +6 |
| news | cold | load | 450 | 456 | +5 |
| news | warm | fcp | 232 | 230 | -2 |
| news | warm | load | 358 | 355 | -2 |
| news | revisit | fcp | 260 | 262 | +2 |
| news | revisit | load | 365 | 371 | +6 |
| interactive | cold | fcp | 140 | 140 | +0 |
| interactive | cold | load | 151 | 151 | -0 |
| interactive | warm | fcp | 132 | 132 | -0 |
| interactive | warm | load | 139 | 137 | -2 |
| interactive | revisit | fcp | 132 | 136 | +4 |
| interactive | revisit | load | 150 | 147 | -3 |

mean of per-fixture median deltas (ms):
('cold', 'fcp') +0.3
('cold', 'load') +1.9
('warm', 'fcp') -0.9
('warm', 'load') -0.7
('revisit', 'fcp') +4.3
('revisit', 'load') +5.1
