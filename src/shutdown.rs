use std::future::Future;

#[cfg(unix)]
pub(crate) fn signal() -> std::io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => (),
            _ = terminate.recv() => (),
        }
    })
}

#[cfg(windows)]
pub(crate) fn signal() -> std::io::Result<impl Future<Output = ()>> {
    use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown};
    let mut interrupt = ctrl_c()?;
    let mut breaks = ctrl_break()?;
    let mut close = ctrl_close()?;
    let mut logoff = ctrl_logoff()?;
    let mut shutdown = ctrl_shutdown()?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => (),
            _ = breaks.recv() => (),
            _ = close.recv() => (),
            _ = logoff.recv() => (),
            _ = shutdown.recv() => (),
        }
    })
}
