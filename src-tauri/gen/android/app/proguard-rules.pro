# Preserve all Vexil application classes and members from obfuscation/shrinking
-keep class com.vexil.app.** { *; }
-keepclassmembers class com.vexil.app.** { *; }

# Keep JavaScript Interface methods and annotations for WebView
-keepattributes JavascriptInterface
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Preserve native methods and classes with native methods
-keepclasseswithmembernames class * {
    native <methods>;
}

# Explicitly preserve SafBridge and all its static methods for JNI
-keep class com.vexil.app.SafBridge {
    public static *;
    *;
}
-keepclassmembers class com.vexil.app.SafBridge {
    public static *;
    *;
}

# Explicitly preserve VexilIndexingService
-keep class com.vexil.app.VexilIndexingService { *; }
-keepclassmembers class com.vexil.app.VexilIndexingService { *; }

# Preserve line numbers for stack traces
-keepattributes SourceFile,LineNumberTable