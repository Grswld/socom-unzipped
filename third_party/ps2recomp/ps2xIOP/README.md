# ps2xIOP

`ps2xIOP` is the IOP high-level emulation (HLE) subsystem used by
`ps2xRuntime`. It implements the behavior that games expect from IOP services
exposed through SIF RPC and DMA.

This subsystem does not emulate the IOP's R3000A CPU and does not load or
execute IRX binaries. Its scope is the RPC/DMA behavior needed by recompiled
games.

> [!IMPORTANT]
> `ps2_iop`/`ps2x::iop` is a C++20 static library linked into the runtime.
> Optional `.dll` and `.so` files are native profile plugins loaded by that
> library. They extend the profile catalog; they do not replace `ps2_iop`, its
> registry, its host bridge, the SIF transport, or execute PS2 IRX code.

## Architecture

```text
EE game
  |
  | SIF RPC / DMA
  v
ps2xRuntime transport
  |
  | RpcRequest / RpcResult / SifTransfer
  v
ps2x::iop::IopSubsystem
  |-- selected game profile services
  |-- core services
  |
  v
IopHost bridge -> validated guest memory, files, audio, memory card,
                  logging, and EE function invocation
```

### Modules, bindings, and profiles

These terms describe different layers:

- A **module implementation** is a reusable protocol engine, such as 989snd,
  lgaud or eznetcnf.
- A **binding** contains build-specific values: SIDs, absolute EE addresses,
  callback addresses, guest arenas, archive names, and protocol variants.
- A **profile** matches one game build and creates the required module
  implementations with that build's bindings.

Sprint 13 Task C7 (audit F24): upstream's other-game profiles (`recvx-us`,
`lotr-two-towers-us`, `fatal-frame-us`) and their five modules (TSNDDRV, CRI
DTX, CLFILE, the LotR SOUND stub, SDRDRV) were removed from this tree; they
were compiled into the SOCOM II runner and never selected. A module reused by
another game should be reused only after its wire protocol has been compared
with the characterized variant.

## Built-in services and profiles

Core services are created for every `IopSubsystem`:

| Service | SID | Availability |
| --- | --- | --- |
| MCSERV | `0x80000400`, `0x80000480` | Always active |
| LIBSD | `0x80000701` | Always active |
| DBCMAN | `0x80001300` | Always active |

The built-in game profiles are one per disc revision (PR #86, 2026-09-27):

| Profile | Matcher | Services |
| --- | --- | --- |
| `socom2-us` | `socom2_game.elf` | 989snd, lgaud and eznetcnf |
| `socom2-us-r0004` | `socom2_game_r0004.elf` | 989snd, lgaud and eznetcnf |

Each declares only the ELF basename; neither constrains the entry point or
CRC32. Basename matching is case-insensitive. `ps2xTest` holds the table to
these two rows.

If no profile matches, the subsystem still has MCSERV, LIBSD, and DBCMAN. It
does not create any game-specific service. An unknown SID remains unhandled so
the SIF transport can apply its normal fallback behavior and report it in the
debugger.

## Profile selection

When an ELF is loaded, the runtime calculates one `GameIdentity`:

- ELF basename;
- entry point;
- CRC-32/IEEE (the common ZIP CRC-32) over the complete ELF file.

A profile matcher may declare any combination of those fields. Every declared
field must match. The matcher with the greatest number of declared fields wins.
Two matching profiles with equal specificity are an error; `loadELF()` fails
instead of silently choosing one.

A duplicate SID within the same service layer is an
error. Routing selects one service per SID: if a profile shadows a core SID and
then returns `handled = 0`, the subsystem does not make a second attempt through
the shadowed core service.

## Dispatch and transfer flow

`IopSubsystem` exposes five operations used by the runtime:

1. `configure(GameIdentity)` selects and creates the active profile.
2. `reset()` resets core and profile services.
3. `selectRpcAbi(...)` lets a service choose the register or stack RPC layout when the default decoder is not sufficient.
4. `handleRpc(...)` routes a request by SID and returns both the payload result and the transport policy.
5. `onSifTransfer(...)` notifies services before and after SetDma and GetOtherData copies.

`RpcResult::handled` indicates whether a service consumed the request. The
result can also request completion semaphore signals and can suppress the
runtime's default EE callback or registered-server dispatch. The transport
executes those actions; the service never reaches into runtime internals.

The transfer hook is deliberately generic: the SIF transport contains no game
names, game addresses, or branches for particular modules.

RPC ABI selection is offered to every active profile service before the core
services, and every active service receives each SIF transfer notification.
Implementations must filter the relevant SID/function or transfer
kind/phase/address range themselves.

## Linking the static library 

```cmake
target_link_libraries(my_runtime PRIVATE ps2x::iop)
```

The public C++ API is
[`iop_subsystem.h`](include/ps2x/iop/iop_subsystem.h). Applications using
`PS2Runtime` normally do not construct it directly; the runtime creates the
subsystem and its `IopHost` adapter.

## Dynamic profile plugins

Dynamic plugins are optional and disabled by default. Enable them on Windows or
Linux with `PS2X_IOP_ENABLE_PLUGINS=ON`.

| Platform | Plugin format | Status |
| --- | --- | --- |
| Windows | `.dll` | Supported |
| Linux | `.so` | Supported |

When enable By default, the runtime scans `iop_plugins/` next to the executable. Discovery
is non-recursive. An embedding application can replace the search directories
before calling `initialize()`:

```cpp
runtime.setIopPluginSearchPaths({
    std::filesystem::path{"path/to/my/iop_plugins"},
});
```

Each native module can publish one or more profiles. Missing query symbols,
incompatible ABI versions, malformed descriptors, and unsupported modules are
ignored with a diagnostic. Profile ambiguity, an active-layer SID conflict, or
failure to create the selected profile makes `loadELF()` fail with a clear
error.

The v1 loader accepts at most 256 profiles per plugin and 256 SIDs per profile.
A profile needs a non-empty ID, at least one matcher field, at least one SID,
and valid `create`, `destroy`, `reset`, and `handle_rpc` callbacks.

## Plugin ABI v1

Plugins include
[`plugin_api.h`](include/ps2x/iop/plugin_api.h) and export exactly one C entry 
point:

```c
PS2X_IOP_PLUGIN_EXPORT int32_t
ps2x_iop_query_v1(uint32_t host_abi_version, ps2x_iop_plugin_api_v1 *plugin_api);
```

The ABI uses only fixed C function tables and POD data:

- validate `abi_version` and `struct_size` before accessing a structure;
- use pointer-plus-length string and buffer views;
- keep the profile instance behind an opaque `void *` handle;
- implement `create`, `destroy`, `reset`, and `handle_rpc`;
- optionally implement RPC ABI selection, SIF transfer hooks, and debug metrics;
- use host callbacks for guest memory, files, audio, memory cards, logging, and
  EE function invocation;
- never retain request/result pointers after a callback returns;
- never pass STL types, C++ classes, exceptions, runtime objects, allocators, or
  raw guest-memory pointers across the ABI.

The plugin itself may be implemented in C or C++, but exceptions must not cross
the exported C boundary. Guest buffer fields are PS2 addresses, not host
pointers.

The `host` function table passed to `create` may be retained until `destroy`.
The identity and its strings, RPC request/result, transfer, and metric pointers
are callback-scoped and must not be retained. `invoke_guest_function` is valid
only during `handle_rpc` and must use that request's `call_token`. Close file
handles and release guest allocations in `reset`/`destroy`.

Most `int32_t`-returning host callbacks return a `PS2X_IOP_STATUS_*_V1` code.
Two are intentionally boolean-style: `has_guest_function` and
`invoke_guest_function` return `1` for yes/success, `0` for no/failure, and a
negative value for an API error. Do not compare their successful result with
`PS2X_IOP_STATUS_OK_V1`, which is zero.

When compiling as C++, keep the exported query function under `extern "C"`
linkage. Including `plugin_api.h` provides the matching C declaration.

FOr learn more you can check [PluginExample](./PluginExample.md)

## Diagnostics and tests

`debugSnapshot()` exposes the active profile, its provider, registered core and
profile services, service metrics, loader diagnostics, and the last selection
error. The runtime debugger renders this data in the **IOP/SIF** tab.

Registry behavior, instance isolation, reset, built-in services, profile
precedence, plugin discovery, ABI rejection, ambiguity, dispatch, destruction,
and module lifetime are covered by
[`ps2_iop_tests.cpp`](../ps2xTest/src/ps2_iop_tests.cpp).
