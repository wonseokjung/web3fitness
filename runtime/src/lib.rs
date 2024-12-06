#![cfg_attr(not(feature = "std"), no_std)]

pub use frame_support::{
    construct_runtime, parameter_types,
    traits::{ConstU128, ConstU32, ConstU64, ConstU8},
};

// Construct Runtime
construct_runtime!(
    pub enum Runtime where
        Block = Block,
        NodeBlock = opct_primitives::Block,
        UncheckedExtrinsic = UncheckedExtrinsic
    {
        System: frame_system,
    }
);
