Place your icon PNG files here:

  icon_small.png  - Titlebar icon (recommended: 24x24 or 32x32 pixels)
  icon_large.png  - Taskbar / alt-tab icon (recommended: 64x64 or larger)

Both must be PNG format.

On Windows, the GDI+ loader in desktop_app.py converts them to HICONs at runtime
(pywebview's icon= parameter is unreliable on Windows and can raise a .NET
exception with PNG files).

On Linux (GTK) and macOS (Cocoa/Qt), pywebview accepts the PNG directly via
icon=, so icon_large.png is used for the window/taskbar icon.

If these files are missing, the app still works - it just uses the default
Python icon. The icon code gracefully handles missing files.
