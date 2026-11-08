//! Модель движка (spec 035, contracts/engine-api.md). Phase 2 — таблицы, на которые опирается
//! хранилище и `engineInfo()`: виды записей хранилища и их форматы, известные возможности устройства.
//! Намерения, изменения модели и представления появятся с `engine/v1/model.proto`.

pub mod features;
pub mod store_kinds;
