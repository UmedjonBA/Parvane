# Parvane: JNI зовёт ParvaneCore.onEvent по имени, натив-методы — по сигнатуре
-keep class org.parvane.core.ParvaneCore { *; }
-keepclasseswithmembernames class * { native <methods>; }
# TdApi — DTO без рефлексии; R8 оставит только используемое
