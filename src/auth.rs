use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::http::{HeaderMap, header};
use rand::RngCore;

const CODE_LIFETIME: Duration = Duration::from_secs(60);
const SESSION_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Clone)]
pub struct Auth {
    token: Arc<String>,
    credentials: Arc<Mutex<Credentials>>,
    cookie_name: Arc<String>,
}

#[derive(Default)]
struct Credentials {
    codes: HashMap<String, Instant>,
    sessions: HashMap<String, Instant>,
}

impl Auth {
    pub fn new(token: String) -> Self {
        Self {
            token: Arc::new(token),
            credentials: Arc::default(),
            cookie_name: Arc::new("lain_session".into()),
        }
    }

    pub(crate) fn with_port(mut self, port: u16) -> Self {
        self.cookie_name = Arc::new(format!("lain_session_{port}"));
        self
    }

    pub(crate) fn cookie_name(&self) -> &str {
        &self.cookie_name
    }

    pub fn launch_code(&self) -> String {
        let now = Instant::now();
        let mut credentials = self.credentials.lock().expect("auth lock poisoned");
        credentials.codes.retain(|_, expires| *expires > now);
        credentials.sessions.retain(|_, expires| *expires > now);
        let code = random_credential();
        credentials.codes.insert(code.clone(), now + CODE_LIFETIME);
        code
    }

    pub fn exchange(&self, code: &str) -> Option<String> {
        let now = Instant::now();
        let mut credentials = self.credentials.lock().expect("auth lock poisoned");
        let expires = credentials.codes.remove(code)?;
        if expires <= now {
            return None;
        }
        credentials.sessions.retain(|_, expires| *expires > now);
        let session = random_credential();
        credentials
            .sessions
            .insert(session.clone(), now + SESSION_LIFETIME);
        Some(session)
    }

    pub(crate) fn bearer_authorized(&self, headers: &HeaderMap) -> bool {
        if self.token.is_empty() || headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
            return false;
        }
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|value| equal_credential(value.as_bytes(), self.token.as_bytes()))
    }

    pub fn authorized(&self, headers: &HeaderMap) -> bool {
        if self.bearer_authorized(headers) {
            return true;
        }
        let mut session = None;
        for cookie in headers.get_all(header::COOKIE) {
            let Ok(cookie) = cookie.to_str() else {
                return false;
            };
            for field in cookie.split(';') {
                let Some((name, value)) = field.trim().split_once('=') else {
                    continue;
                };
                if name == self.cookie_name() && session.replace(value).is_some() {
                    return false;
                }
            }
        }
        let Some(session) = session else { return false };
        let mut credentials = self.credentials.lock().expect("auth lock poisoned");
        let now = Instant::now();
        credentials.sessions.retain(|_, expires| *expires > now);
        credentials.sessions.contains_key(session)
    }
}

fn random_credential() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn equal_credential(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_codes_are_single_use_and_expire_at_the_deadline() {
        let auth = Auth::new("secret".into());
        let code = auth.launch_code();
        assert!(auth.exchange(&code).is_some());
        assert!(auth.exchange(&code).is_none());
        let expired = auth.launch_code();
        auth.credentials
            .lock()
            .unwrap()
            .codes
            .insert(expired.clone(), Instant::now());
        assert!(auth.exchange(&expired).is_none());
    }

    #[test]
    fn browser_sessions_expire_and_never_authorize_bearer_only_routes() {
        let auth = Auth::new("secret".into());
        let session = auth.exchange(&auth.launch_code()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("lain_session={session}").parse().unwrap(),
        );
        assert!(auth.authorized(&headers));
        assert!(!auth.bearer_authorized(&headers));
        auth.credentials
            .lock()
            .unwrap()
            .sessions
            .insert(session, Instant::now());
        assert!(!auth.authorized(&headers));
    }
}
