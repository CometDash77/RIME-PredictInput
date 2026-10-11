#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

/* Same machine registry location as upstream NSIS. No Python or author path. */
static int launch(const wchar_t *arguments) {
    wchar_t parent[32768], exe[32768], command[32768];
    DWORD bytes = sizeof(parent);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"Software\\Rime\\Weasel",
        L"InstallDir", RRF_RT_REG_SZ | RRF_SUBKEY_WOW6432KEY, NULL,
        parent, &bytes) != ERROR_SUCCESS) return 0;
    if (swprintf_s(exe, 32768, L"%s\\weasel-0.17.4\\predict\\rime-predict-sidecar-gui.exe", parent) < 0)
        return 0;
    if (GetFileAttributesW(exe) == INVALID_FILE_ATTRIBUTES) return 0;
    if (swprintf_s(command, 32768, L"\"%s\" %s", exe, arguments) < 0) return 0;
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(exe, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
        NULL, NULL, &startup, &process)) return 0;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 1;
}

/* Lua C function: no Lua headers/import library needed; push no return values. */
__declspec(dllexport) int __cdecl rime_model_predict_start(void *state) {
    (void)state;
    launch(L"--source lua");
    return 0;
}

__declspec(dllexport) int __cdecl rime_model_predict_open_settings(void) {
    return launch(L"settings");
}
