use std::{
    fs::{self, File},
    io,
    path::Path,
};

use anyhow::{Result, ensure};
#[cfg(unix)]
use std::fs::OpenOptions;

#[cfg(windows)]
#[path = "windows_files.rs"]
mod windows;

pub(crate) fn create_private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    #[cfg(windows)]
    windows::create_directory(path)?;
    check_private_directory(path)
}

pub(crate) fn check_private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !is_link(&metadata),
        "unsafe directory: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            metadata.mode() & 0o7777 == 0o700,
            "runtime home must have mode 0700: {}",
            path.display()
        );
    }
    #[cfg(windows)]
    windows::check_directory(path)?;
    Ok(())
}

pub(crate) fn open_private(path: &Path, writable: bool, create_new: bool) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(writable)
            .create_new(create_new)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(path)
    }
    #[cfg(windows)]
    windows::open_private(path, writable, create_new)
}

pub(crate) fn check_private_file(file: &File, path: &Path) -> Result<()> {
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && !is_link(&metadata) && link_count(file)? == 1,
        "unsafe file: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            metadata.mode() & 0o7777 == 0o600,
            "file must have mode 0600: {}",
            path.display()
        );
    }
    #[cfg(windows)]
    windows::check_file(file)?;
    Ok(())
}

pub(crate) fn link_count(file: &File) -> io::Result<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(file.metadata()?.nlink())
    }
    #[cfg(windows)]
    windows::link_count(file)
}

pub(crate) fn identity(path: &Path) -> io::Result<(u64, u64)> {
    let file = open_private(path, false, false)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    windows::identity(&file)
}

pub(crate) fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        metadata.file_type().is_symlink()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
}

pub(crate) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::rename(source, destination)
    }
    #[cfg(windows)]
    windows::replace_file(source, destination)
}

pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
}
