/**
 * PuTTY key files written by PuTTYgen, taken from other projects' test suites
 * so the converter is checked against the real thing rather than against its
 * own reading of the format. Test keys only; none of them opens anything.
 */
export const FIXTURES: Array<{ source: string; text: string; passphrase?: string }> = [
  {
    source: 'kayrus/putty: puttygen -t rsa -b 512 -C a@b -o pass.ppk',
    passphrase: 'testkey',
    text: `PuTTY-User-Key-File-2: ssh-rsa
Encryption: aes256-cbc
Comment: a@b
Public-Lines: 2
AAAAB3NzaC1yc2EAAAABJQAAAEEAorCK9W8rDXirgPGwRLXZOQYlASsqjMQ2t9xQ
k1Aw+f8JJ7qYaFEwpcWGWf/br3n83FIl18r3AIIIU/WjiUIlbw==
Private-Lines: 4
ZJsVbNlwaPjIrs9KiYIWTaBXifB7jJH6CdADEd5DV2jhQk+xi5PWdNf1uLnlAPpE
0OvpMjU66gTsjuirmyi53nRFtqoCjjm7waf3x9lbNDoVUhWTV+JK4NTR2T0nnjnO
D51wcjdd2aEcpvif7LNSksRJZkJuMJVt2o68SDM4kQlQivc9lBf3HR8t3yxxjNV2
lmHm9dFVUGKo7nh/eyWzo1AibICdfMnc4pc69FstgM5Nuetl1Lq157XFvKKZyisd
Private-MAC: 7f8e59f1f2268600076dbdef55c6acb91c6c1578
`
  },
  {
    source: 'kayrus/putty: puttygen -t dsa -b 2048 -C a@b -o pass.dsa.ppk',
    passphrase: 'testkey',
    text: `PuTTY-User-Key-File-2: ssh-dss
Encryption: aes256-cbc
Comment: a@b
Public-Lines: 18
AAAAB3NzaC1kc3MAAAEBAMLTkybOY3kUIdFXaZq2osYuxwaqYum65goAUvZmanCG
Mim9TRNCw+DA+MiZduKgBcXPuTFZyVNkDDodWW6KhHgT3sMHsIA5Mh9XvyrtQKvv
1yOGeHUOwjxohQQm5NVr5CQcpkyd3x8bHcaiFEaTZDuw7GksbW2lsa4lyv0GFUc8
9gaLDMC9ipOwFER2pP7AlIg9qj5Qgrj2z/KkZQGVPObae2L+oqkfwD8rX5cHWzie
ARxQDfVhOagF32Jaxt4+QODGD00cN1oCRtkOUD5HPy96HvOx0xwhDrAU9YQPgl2q
SaB3Bq6s2C+9Dn01ugQ7ik99cDhFp2HefwUcCGqb8zMAAAAVAOXfaExPDDBbC0JB
0JQpnyRyfTcBAAABAFKVIBswBAA845IZ8fuMcA8JXzLbJqq5IyYL5P9nDNZFMbSm
5pJbpV5msnYfJBgeFhX4buXbve7ehctIpVgkShWIIMgT5mKQv6BvaOchkIFwKdQE
dypPmJOgSCiij3000TVzky4A6KZZI7+XtC+rtjnDjuk6v2dn4hVa2khW/Adr/eHU
RCDfez1bJobglBs9xtYIOmw1xZzaRQi1nKBUimfxFEGMRinhCss+1qh73K6HRvTC
9kEgJ4Lrn6NJQFtlFB4P2PEcqfKp3EsbGGlV52XLIv5fHvtt2xR24k2oebcS2fq+
dXEg5Sg9AnOY7t3KwMWrv+2KRC7XGh+55+pfOdMAAAEBAKplqzkQyLR+55/DJC9s
JeAsBHhws+xCLkX1waKCrCVjkhsz35WrEGIgsboJ2I9KIZO3be7XReyMLMEAcBBf
f0RZ6ZlsbqPByoOBYUdahlwLc/m71pUs6X6yLv9MLW46BTmTneZRGtLTdK2ouSbW
q1gbY2p8dnR2TrCThmde+2U4RzFvI30Layu1Amst6kt9Zcz3eV+lxpR7vNFgq4kB
2QgVgh8e7keg1ebzl0nRBk4+kFZhLOT5nY4aJ1TRiD4TGuSugBQSfRW60LOf4R28
aWxu7A5Jbsm8fATR3N0bWgOQWc4cRC7t3mb0Xrt2bW2amcWEkZF57uV5Ldv7aKAK
MXs=
Private-Lines: 1
IcDcTw/elt2xwgWoweaz0wb4mHVCLc3w64YXc8hxouE=
Private-MAC: 30b6587e0f0e4baf38895408d5d6c903add96816
`
  },
  {
    source: 'kayrus/putty: puttygen -t ecdsa -b 256 -C a@b -o pass.ecdsa.ppk',
    passphrase: 'testkey',
    text: `PuTTY-User-Key-File-2: ecdsa-sha2-nistp256
Encryption: aes256-cbc
Comment: a@b
Public-Lines: 3
AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBGascQ2IAWOr
eeFFvfkMPrEzIv9YzW4xPAhdnKcHmpBaCGnru7j5YilLdanHF1j3E65/nsUJOAt8
+j3eSrULEEE=
Private-Lines: 1
61hg1CoGUcsBB8u5TD48gzdmxMDP6+D+GhD4UzDisD+iKehU8PatDdQIVtRUY8ja
Private-MAC: 07bafdfa36c3184d01f79e0db8f668e761ab4e20
`
  },
  {
    source: 'kayrus/putty: puttygen -t ecdsa -b 384 -C a@b -o pass.ecdsa.ppk',
    passphrase: 'testkey',
    text: `PuTTY-User-Key-File-2: ecdsa-sha2-nistp384
Encryption: aes256-cbc
Comment: a@b
Public-Lines: 3
AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBMLZhNzFeAQG
bMx96v8vL/a+bI/nF1/8iN6cXgGph/IodS1G/ikq75ufDbKH+0ZmKnlP3j08Vtit
pkdmmIkTukvrrLlYnhN4BY5qyvy259a3j6RUGvYzYA33t5FQW9PCOQ==
Private-Lines: 2
tQBqst/bUEfUTKGbBv17b1Mb38AYaUT3Wposs+ZydBc1uHg54tM+kzCuon+4/36o
dRKoYQjl8YUcKtPkihNRKw==
Private-MAC: 898b91d24130483ba2a5cf478ed65386b325aba8
`
  },
  {
    source: 'kayrus/putty: puttygen -t ecdsa -b 521 -C a@b -o pass.ecdsa.ppk',
    passphrase: 'testkey',
    text: `PuTTY-User-Key-File-2: ecdsa-sha2-nistp521
Encryption: aes256-cbc
Comment: a@b
Public-Lines: 4
AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAFIXU1DQU+c
yADEnp95G7N7zxNQ2Bj7bAz5cAIxEcBuGd707/Z96eZGsF4din4Grfse4gFmKsNO
Uzdo0QPZ4BDdLACe5gysjxHi5Qa65y79PjpOo8qYCDIocf/aeX24Q8MlnbNK4lHO
M8j6NJi2tQsp/Vaf1h+FHViV4meyanYyjZrljQ==
Private-Lines: 2
7KW71RQdH1EQD2nBdI7y8JmufwoX2bupP8QCcS9/bS+pZQCGu0XuzBd8YswfUl9H
fKT7hsBrywG5Z3ujmLerhf1bCIKotolmpxGQyPE0bCE=
Private-MAC: 586871c9dad8859f3d9b6efad81d3c26d923040c
`
  },
  {
    source: 'kayrus/putty: puttygen -t ed25519 -b 256 -C a@b -o pass.ed25519.ppk',
    passphrase: 'testkey',
    text: `PuTTY-User-Key-File-2: ssh-ed25519
Encryption: aes256-cbc
Comment: a@b
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIMb3N9pbqMpSJRFb/WF8Wcz80SiW8emW3aLFqdRA
rs+r
Private-Lines: 1
i6a/aAknwkK/cVT8nW9zcsOJDvOdPvfBlx0suOtygmSbz9L4yoBAZZu8AHxWDSgm
Private-MAC: 8fa9edfc1b94bec840ee1526d290bf1d8eb9fbc9
`
  },
  {
    source: 'kayrus/putty: puttygen -t rsa -b 2048 -C a@b -o rsa2048.ppk3',
    text: `PuTTY-User-Key-File-3: ssh-rsa
Encryption: none
Comment: a@b
Public-Lines: 6
AAAAB3NzaC1yc2EAAAADAQABAAABAQDNsvsFOGphVzbJJAARnMs2E9p6jheXLTz7
dnZqNwZCYomnGurAPEuKmxD3GzdT+xP4BLFbAGDkeJHmjiNAPnbJf7G90u2zD28Y
J/c/krfKli50ZUOXG1a2DUhIvRM1GewOLhE7q5AOBHLQNFXvU9LR08t9H3u9xPJI
xNJjP6LqRGn+fP1xqlTbG3NTwCZMMXgXuAUhXGKaKbLUBN5SYmLvLTB6KzdHJQ6x
H9X+2Ul4hExje5L2X8miQqTxPloNtQNqpEtR2X7ecLyM9v3N1yDUK/NLwJ+PX8C8
KRbuBi5+xp+k62+btFXIk6CgGpsda/KleLmzTk5QJGLA9DfzrvAd
Private-Lines: 14
AAABAQCWR5StE7Jku1sDSJHkTDEKqSaNMxJ5GEvdS4bnwpuIFIWM2FV5bJOkB/Y1
EmUxrdXA9Wy9l2EyigPN9To7zWbrf6dTj66pizUW6NvyTjaIg4Ac+X6P/yEykDGn
Mru9p9qV4YIlngn4s7dN9W5zE0KKmbmpCD9XPXPlRiaO7AcSLujUHp7kPij2i9EL
vYRy0TS2g/HbQlBiaCS3+RI5K1UrwSP/MUFzmy319ZuI5XZUz7Z7OER4tgFi8qth
HqPkvBTnbi3ORIhRQQT+faEmKHwyDuXTXlITWj+1k3wY6sdr308OfRut6OcH417U
/YcZfBK6A3iZ9AJ/ih1Sqd0xCDkBAAAAgQD6IYSnq2k8LcGZvEtMt/izjFQICaJu
xvIbXBRsTqMmpNZiaDJU4i8NTbvfHBOSkx2Ip9dFQIVy9ijOuwg24VuXyCDY8Rzb
L/3Wkz/a1q4CJJSXgOpqQF60Dk8nYNRqEc2ykGkn/3GV/uqWbz0ohS1Wr55XiZeJ
fUSKmI72Yk6BVQAAAIEA0oaSAScm+gat8e6jAGpm1mHwf3iLI34NVgY3TzpL4kyz
Xk0OpxWMY5cgoXmWMnT1yCpun9SYBzyRhrfY8x7VPcNC9X96hNp/nIkp/FIWq/8M
TV2SIFcxidXpwMbGD8HXjAng+AkNYlK8ow/SDEkYsHWKuZsf99VqiHzgs5Y5U6kA
AACBAJ3N00Sgdv036FTLnU+NlF4N0kjhzjMDAPWRf9XvwkugiyB2tZ43rVCmXzgE
FzNeuOrWXPC7xh9Jfbg04rJv7sYZhSIIadTO3y3ToPXHpRNwg9pmC1BaQLMb0I5M
JUUNn5ASrFQki0/Ok5mwxz+QpktrvUuShkd/4e+sqHZ5mZ0n
Private-MAC: cceed3168be3c35863ebff8ff41457aa5ab449603b5660df1a4eea0201827c44
`
  },
  {
    source: 'kayrus/putty: puttygen -t rsa -b 2048 -C a@b -o rsa2048.ppk3',
    passphrase: 'testkey',
    text: `PuTTY-User-Key-File-3: ssh-rsa
Encryption: aes256-cbc
Comment: a@b
Public-Lines: 6
AAAAB3NzaC1yc2EAAAADAQABAAABAQDNsvsFOGphVzbJJAARnMs2E9p6jheXLTz7
dnZqNwZCYomnGurAPEuKmxD3GzdT+xP4BLFbAGDkeJHmjiNAPnbJf7G90u2zD28Y
J/c/krfKli50ZUOXG1a2DUhIvRM1GewOLhE7q5AOBHLQNFXvU9LR08t9H3u9xPJI
xNJjP6LqRGn+fP1xqlTbG3NTwCZMMXgXuAUhXGKaKbLUBN5SYmLvLTB6KzdHJQ6x
H9X+2Ul4hExje5L2X8miQqTxPloNtQNqpEtR2X7ecLyM9v3N1yDUK/NLwJ+PX8C8
KRbuBi5+xp+k62+btFXIk6CgGpsda/KleLmzTk5QJGLA9DfzrvAd
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 13
Argon2-Parallelism: 1
Argon2-Salt: 745d60746c67666afa47dbf23226c6c9
Private-Lines: 14
gqyGdBy5Nhxs5w00/7LUKZVUgwKVbTOcDjMh0ItVc5mWr7PoqtJhzrv7o8zEshHL
vviIJJ2NTo+whHEStAIaxqnJC0/KWSXvnhElH0+27+Yvkz+Z32hyczSbQp/fsBSA
3ZMQoyR92uAjG+gV7b0mqgsC0JWyaZYvippMNBHArZM8kaXdUYLDgmeXwIf7o/1I
QVh6RPanavcbDtafumHF2bIRCq5og1UoiaVyysgSMdrDpkkFvjHNwc4+xDEqnH3u
3v9PLIsolhbWUM7BwC1PnuCiaagbRvXoq+QTfdT5cbQw8lFngTgYT5NDkGJKMjB2
qoDIOYOK8NsoiUxk2UvPP4XpwfJyHYL1LuS3B85e3/RbVcfM2UIm/75CNb/yLJ09
1x4oLNBDkZQDhxwsT7VMg+h97eq/zJVhoAUXKN17JoV9hVmi5J46tskLAKhWA2vs
QuDd6pfxjc8TyaiMLNTDr7/72UNw/mn7zH9GedyhMRhyYnzy8qYOFa5k6/bFnV89
qRmKUqkaVDDf6dGtOOVvGP4iWj8TzrQsOa2qyj4UNUdj/9BSYHvodNPkOFMhUHqn
fUU6RUKUV3q1Uoj5E8HaMR7OHNMSx9OA7iWcpuMYAYbcyq4OJcE6ggy3FImrgTe0
9fBTw4Og3p91nBwOTajVj57wg5cs34YfBUQK+6P38A7+xTLBaVwvawaovAyVdDkD
y1Ae/WtloFz5aRzt8cNYfxvyzoFrGPRaomFgltLfLBhDELZcpXF8TQFpswN/wo4o
REFZdIWdiIYROykhX+FbKVMiufqj+snbpPACudio/DeC03Dj5oagDNJ5sfqiHn2m
93g2/twM3JT/bJOD01jL00yaSgaR4lWTelKbfrtqrgcZR1EryBwHv7VZykR066xJ
Private-MAC: 819054f7340f430ab9896ad76559cd2d489ab23bc517113e1cd425f461fac726
`
  },
  {
    source: 'PuTTY test/cryptsuite.py, testPPKLoadSave (clear)',
    text: `PuTTY-User-Key-File-2: ssh-ed25519
Encryption: none
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Private-Lines: 1
AAAAIGvvIpl8jyqn8Xufkw6v3FnEGtXF3KWw55AP3/AGEBpY
Private-MAC: 2a629acfcfbe28488a1ba9b6948c36406bc28422
`
  },
  {
    source: 'PuTTY test/cryptsuite.py, testPPKLoadSave (encrypted)',
    passphrase: 'test-passphrase',
    text: `PuTTY-User-Key-File-2: ssh-ed25519
Encryption: aes256-cbc
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Private-Lines: 1
4/jKlTgC652oa9HLVGrMjHZw7tj0sKRuZaJPOuLhGTvb25Jzpcqpbi+Uf+y+uo+Z
Private-MAC: 5b1f6f4cc43eb0060d2c3e181bc0129343adba2b
`
  }
]
