//! "Share with mdshare" in the Windows Explorer right-click menu, for folders,
//! folder backgrounds and .md files. Per-user (HKCU), so no admin rights are
//! needed. On Windows 11 it appears under "Show more options".

use std::process::Command;

const LABEL: &str = "Share with mdshare";

/// (registry key, argument placeholder Explorer substitutes)
const KEYS: &[(&str, &str)] = &[
    (r"HKCU\Software\Classes\Directory\shell\mdshare", "%V"),
    (
        r"HKCU\Software\Classes\Directory\Background\shell\mdshare",
        "%V",
    ),
    (
        r"HKCU\Software\Classes\SystemFileAssociations\.md\shell\mdshare",
        "%1",
    ),
    (
        r"HKCU\Software\Classes\SystemFileAssociations\.markdown\shell\mdshare",
        "%1",
    ),
];

fn reg(args: &[&str]) -> anyhow::Result<()> {
    let out = Command::new("reg").args(args).output()?;
    anyhow::ensure!(
        out.status.success(),
        "reg {} failed: {}",
        args.first().unwrap_or(&""),
        String::from_utf8_lossy(&out.stderr).trim()
    );
    Ok(())
}

pub fn install() -> anyhow::Result<()> {
    anyhow::ensure!(
        cfg!(windows),
        "the context menu is only available on Windows"
    );
    let exe = std::env::current_exe()?;
    let exe = exe.to_string_lossy();
    for (key, arg) in KEYS {
        reg(&["add", key, "/ve", "/d", LABEL, "/f"])?;
        reg(&["add", key, "/v", "Icon", "/d", &exe, "/f"])?;
        // `cmd /c` keeps a console window for the QR code; `|| pause` keeps it
        // open if mdshare exits with an error so the message can be read.
        let command = format!(r#"cmd.exe /c ""{exe}" "{arg}" || pause""#);
        reg(&[
            "add",
            &format!(r"{key}\command"),
            "/ve",
            "/d",
            &command,
            "/f",
        ])?;
    }
    Ok(())
}

pub fn uninstall() -> anyhow::Result<()> {
    anyhow::ensure!(
        cfg!(windows),
        "the context menu is only available on Windows"
    );
    for (key, _) in KEYS {
        // Missing keys are fine.
        let _ = reg(&["delete", key, "/f"]);
    }
    Ok(())
}
