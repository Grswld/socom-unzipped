# 989snd RPC differential: real IRX (#254 LLE IOP + provider, Sprint 15 T1) vs our snd989 model

Log: `logs\run_20260922_232655.log`; 16607 calls replayed; tick 4920000 EE cycles per call; 2 s; PEEK 0048da00 00000000 00000000 00000000 00000000 00000000; SNAP cycles=10214556672 instr=34491225 modules=6 threads=12 servers=3 diagnostics=0 provider=0 reads=0 sectors=0 refused=0 done=0 cdcb=0 syncs=0 breaks=0 dmaintr=0 dmacb=0 opens=0

**Compared answers: 13044; disagreements: 12619.**

| fno | function | calls | agree | disagree | no expected | unhandled |
|---|---|---|---|---|---|---|
| 0x00 | snd_StartSoundSystem | 1 | 0 | 0 | 1 | 0 |
| 0x03 | snd_BankLoadByLoc | 5 | 0 | 5 | 0 | 0 |
| 0x06 | snd_UnloadBank | 1 | 1 | 0 | 0 | 0 |
| 0x08 | snd_ResolveBankXREFS | 17 | 0 | 0 | 17 | 0 |
| 0x09 | snd_SetMasterVolume | 1016 | 0 | 0 | 1016 | 0 |
| 0x0a | snd_GetMasterVolume | 21 | 21 | 0 | 0 | 0 |
| 0x0b | snd_SetPlaybackMode | 1 | 0 | 0 | 1 | 0 |
| 0x0e | snd_SetReverbType | 1 | 0 | 0 | 1 | 0 |
| 0x10 | snd_AutoReverb | 18 | 0 | 0 | 18 | 0 |
| 0x11 | snd_PlaySoundVolPanPMPB | 24 | 0 | 24 | 0 | 0 |
| 0x12 | snd_PlaySoundVolPanPMPBNoReturn | 836 | 0 | 0 | 836 | 0 |
| 0x13 | snd_PauseSound | 2 | 0 | 0 | 2 | 0 |
| 0x14 | snd_ContinueSound | 1 | 0 | 0 | 1 | 0 |
| 0x15 | snd_StopSound | 23 | 0 | 0 | 23 | 0 |
| 0x16 | snd_PauseAllSoundsInGroup | 1 | 0 | 0 | 1 | 0 |
| 0x17 | snd_ContinueAllSoundsInGroup | 1 | 0 | 0 | 1 | 0 |
| 0x18 | snd_StopAllSounds | 3 | 0 | 0 | 3 | 0 |
| 0x19 | snd_SoundIsStillPlaying | 5459 | 13 | 5446 | 0 | 0 |
| 0x21 | snd_SetSoundParams | 7140 | 13 | 7127 | 0 | 0 |
| 0x2a | snd_InitVAGStreamingEx | 2 | 2 | 0 | 0 | 0 |
| 0x2c | snd_PlayVAGStreamByLoc | 29 | 29 | 0 | 0 | 0 |
| 0x34 | snd_StopAllVAGStreams | 6 | 0 | 0 | 6 | 0 |
| 0x35 | snd_ShutdownVAGStreaming | 1 | 0 | 0 | 1 | 0 |
| 0x36 | snd_StreamCdIdle | 340 | 340 | 0 | 0 | 0 |
| 0x38 | snd_StreamSafeCdRead | 7 | 0 | 7 | 0 | 0 |
| 0x3b | snd_PcmStreamOpen | 6 | 6 | 0 | 0 | 0 |
| 0x3c | snd_PcmStreamClose | 6 | 0 | 0 | 6 | 0 |
| 0x3d | snd_PcmStreamStop | 12 | 0 | 0 | 12 | 0 |
| 0x3e | snd_PcmStreamStart | 6 | 0 | 0 | 6 | 0 |
| 0x40 | snd_PcmStreamPosition | 4 | 0 | 4 | 0 | 0 |
| 0x4c | snd_CallExtension | 6 | 0 | 6 | 0 | 0 |
| 0x4e | snd_SetGroupVoiceRange | 5 | 0 | 0 | 5 | 0 |
| 0x64 | snd_SetExternalInputMix | 1 | 0 | 0 | 1 | 0 |
| 0x67 | snd_SetGlobalReg | 1605 | 0 | 0 | 1605 | 0 |

## First 60 disagreements

- #17 `snd_BankLoadByLoc` fno 0x03 logged args ['0x1ead5d', '0x0'] sent ['0x1ead5d', '0x0']: ours 0xa00000 (maps to 0xa00000), IRX 0x0, recv ['0x0', '0x0', '0x0', '0x0']
    - LOG Info [iop] Error Kicking Off Read!
    - LOG Info [iop] 989snd Error: cause 14 -> 48, 0, 0, 0
- #36 `snd_CallExtension` fno 0x4c logged args ['0x12c4e67a', '0x6', '0x0', '0x0', '0x0', '0x0', '0x0'] sent ['0x12c4e67a', '0x6', '0x0', '0x0', '0x0', '0x0', '0x0']: ours 0x1 (maps to 0x1), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #39 `snd_PcmStreamPosition` fno 0x40 logged args [] sent []: ours 0xa0f00 (maps to 0xa0f00), IRX 0x1070000, recv ['0xffffffff', '0x1070000', '0xffffffff', '0x0']
- #40 `snd_PcmStreamPosition` fno 0x40 logged args [] sent []: ours 0xa2d00 (maps to 0xa2d00), IRX 0x1070c00, recv ['0xffffffff', '0x1070c00', '0xffffffff', '0x0']
- #41 `snd_PcmStreamPosition` fno 0x40 logged args [] sent []: ours 0xa4b00 (maps to 0xa4b00), IRX 0x1071800, recv ['0xffffffff', '0x1071800', '0xffffffff', '0x0']
- #42 `snd_PcmStreamPosition` fno 0x40 logged args [] sent []: ours 0xa5a00 (maps to 0xa5a00), IRX 0x1072400, recv ['0xffffffff', '0x1072400', '0xffffffff', '0x0']
- #70 `snd_CallExtension` fno 0x4c logged args ['0x12c4e67a', '0x6', '0x0', '0x0', '0x0', '0x0', '0x0'] sent ['0x12c4e67a', '0x6', '0x0', '0x0', '0x0', '0x0', '0x0']: ours 0x1 (maps to 0x1), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #87 `snd_CallExtension` fno 0x4c logged args ['0x12c4e67a', '0x6', '0x0', '0x0', '0x0', '0x0', '0x0'] sent ['0x12c4e67a', '0x6', '0x0', '0x0', '0x0', '0x0', '0x0']: ours 0x1 (maps to 0x1), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #92 `snd_StreamSafeCdRead` fno 0x38 logged args ['0x1f2e0b', '0x1', '0xfab640'] sent ['0x1f2e0b', '0x1', '0xfab640']: ours 0x1 (maps to 0x1), IRX 0x84000002, recv ['0xffffffff', '0x84000002', '0xffffffff', '0x0']
    - LOG Info [iop] snd_KickDataRead: sceCdRead returned 0 but sceCdGetError returned SCECdErNo!
    - LOG Info [iop] 989snd Error: cause 61 -> 4294967295, 2043403, 11, 628736
- #93 `snd_StreamSafeCdRead` fno 0x38 logged args ['0x1f2e0c', '0x2', '0x1795380'] sent ['0x1f2e0c', '0x2', '0x1795380']: ours 0x1 (maps to 0x1), IRX 0x84000002, recv ['0xffffffff', '0x84000002', '0xffffffff', '0x0']
    - LOG Info [iop] snd_KickDataRead: sceCdRead returned 0 but sceCdGetError returned SCECdErNo!
    - LOG Info [iop] 989snd Error: cause 61 -> 4294967295, 2043404, 11, 628736
- #94 `snd_StreamSafeCdRead` fno 0x38 logged args ['0x1f2e0e', '0x1', '0xfab640'] sent ['0x1f2e0e', '0x1', '0xfab640']: ours 0x1 (maps to 0x1), IRX 0x84000002, recv ['0xffffffff', '0x84000002', '0xffffffff', '0x0']
    - LOG Info [iop] snd_KickDataRead: sceCdRead returned 0 but sceCdGetError returned SCECdErNo!
    - LOG Info [iop] 989snd Error: cause 61 -> 4294967295, 2043406, 11, 628736
- #95 `snd_StreamSafeCdRead` fno 0x38 logged args ['0x1f2e0f', '0x1', '0xfab640'] sent ['0x1f2e0f', '0x1', '0xfab640']: ours 0x1 (maps to 0x1), IRX 0x84000002, recv ['0xffffffff', '0x84000002', '0xffffffff', '0x0']
    - LOG Info [iop] snd_KickDataRead: sceCdRead returned 0 but sceCdGetError returned SCECdErNo!
    - LOG Info [iop] 989snd Error: cause 61 -> 4294967295, 2043407, 11, 628736
- #96 `snd_StreamSafeCdRead` fno 0x38 logged args ['0x1f2e0f', '0x1', '0xfab640'] sent ['0x1f2e0f', '0x1', '0xfab640']: ours 0x1 (maps to 0x1), IRX 0x84000002, recv ['0xffffffff', '0x84000002', '0xffffffff', '0x0']
    - LOG Info [iop] snd_KickDataRead: sceCdRead returned 0 but sceCdGetError returned SCECdErNo!
    - LOG Info [iop] 989snd Error: cause 61 -> 4294967295, 2043407, 11, 628736
- #97 `snd_StreamSafeCdRead` fno 0x38 logged args ['0x1f2e10', '0x1a', '0x1a04c60'] sent ['0x1f2e10', '0x1a', '0x1a04c60']: ours 0x1 (maps to 0x1), IRX 0x84000002, recv ['0xffffffff', '0x84000002', '0xffffffff', '0x0']
    - LOG Info [iop] snd_KickDataRead: sceCdRead returned 0 but sceCdGetError returned SCECdErNo!
    - LOG Info [iop] 989snd Error: cause 61 -> 4294967295, 2043408, 11, 628736
- #98 `snd_StreamSafeCdRead` fno 0x38 logged args ['0x1f2e2a', '0x1', '0xfab640'] sent ['0x1f2e2a', '0x1', '0xfab640']: ours 0x1 (maps to 0x1), IRX 0x84000002, recv ['0xffffffff', '0x84000002', '0xffffffff', '0x0']
    - LOG Info [iop] snd_KickDataRead: sceCdRead returned 0 but sceCdGetError returned SCECdErNo!
    - LOG Info [iop] 989snd Error: cause 61 -> 4294967295, 2043434, 11, 628736
- #100 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #101 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #103 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #104 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #106 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #107 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #109 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #110 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #112 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #113 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #115 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #116 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #118 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #119 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #121 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #122 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #125 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #126 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #128 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #129 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #131 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #132 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #135 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #136 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #139 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #140 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #142 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #143 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #146 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #147 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #148 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #149 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #151 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #152 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #153 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #154 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #156 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #157 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #158 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #159 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #161 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #162 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #163 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #164 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x401000d'] sent ['0x84000003']: ours 0x401000d (maps to 0x84000003), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']
- #166 `snd_SoundIsStillPlaying` fno 0x19 logged args ['0x400000c'] sent ['0x84000002']: ours 0x400000c (maps to 0x84000002), IRX 0x0, recv ['0xffffffff', '0x0', '0xffffffff', '0x0']

## Handle map (30 entries)

- 0xa0000 -> 0xb5200
- 0x400000c -> 0x84000002
- 0x401000d -> 0x84000003
- 0x4000312 -> 0x84000004
- 0x4000327 -> 0x84000005
- 0x400034c -> 0x84000002
- 0x400034e -> 0x84000003
- 0x4000354 -> 0x84000004
- 0x4010355 -> 0x84000005
- 0x4020356 -> 0x84000006
- 0x4000357 -> 0x84000007
- 0x4000358 -> 0x84000008
- 0x4020359 -> 0x84000009
- 0x400035a -> 0x8400000a
- 0x400035d -> 0x8400000b
- 0x400035e -> 0x8400000c
- 0x4000361 -> 0x8400000d
- 0x4000362 -> 0x8400000e
- 0x4010363 -> 0x8400000f
- 0x4000366 -> 0x84000010
- 0x4000367 -> 0x84000011
- 0x400036a -> 0x84000012
- 0x401036b -> 0x84000013
- 0x400036e -> 0x84000014
- 0x401036f -> 0x84000015
- 0x4000370 -> 0x84000016
- 0x4000373 -> 0x84000017
- 0x4010374 -> 0x84000018
- 0x4000375 -> 0x84000019
- 0x4000376 -> 0x8400001a
