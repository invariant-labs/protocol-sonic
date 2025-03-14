pub mod locks;

pub use locks::*;

pub trait DerivedAccountIdent {
    const IDENT: &'static [u8];
}
pub trait DerivedAccountSize {
    const LEN: usize;
}

#[macro_export]
macro_rules! derive_account_size {
    ($name:ident) => {
        impl DerivedAccountSize for $name {
            const LEN: usize = $name::INIT_SPACE + 8;
        }
    };
}

#[macro_export]
macro_rules! derive_account_ident {
    ($name:ident) => {
        impl DerivedAccountIdent for $name {
            const IDENT: &'static [u8] = stringify!($name).as_bytes();
        }
    };
    ($name:ident, $custom_ident:expr) => {
        impl DerivedAccountIdent for $name {
            const IDENT: &'static [u8] = $custom_ident;
        }
    };
}
