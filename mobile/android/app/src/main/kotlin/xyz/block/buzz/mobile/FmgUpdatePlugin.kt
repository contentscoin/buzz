package xyz.block.buzz.mobile

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/** Verifies only FMG release updates in the app-owned updater cache. */
internal class FmgUpdatePlugin(
    private val activity: FlutterFragmentActivity,
    messenger: BinaryMessenger,
) {
    private val channel = MethodChannel(messenger, "fmg/app_updates")
    private val busy = AtomicBoolean(false)

    init {
        channel.setMethodCallHandler { call, result ->
            if (activity.packageName != APP_ID) {
                result.error("unsupported", "FMG Android only", null)
            } else if (call.method !in setOf("verify", "install")) {
                result.notImplemented()
            } else {
                val payload = call.arguments as? Map<*, *>
                val digest = payload?.get("sha256") as? String
                val buildNumber = (payload?.get("buildNumber") as? Number)?.toLong()
                if (digest == null || !digest.matches(Regex("[0-9a-f]{64}")) ||
                    buildNumber == null || buildNumber !in 1..Int.MAX_VALUE.toLong()) {
                    result.error("invalid_update", "Invalid update metadata", null)
                } else {
                    if (!busy.compareAndSet(false, true)) {
                        result.error("busy", "Update verification already in progress", null)
                        return@setMethodCallHandler
                    }
                    Thread {
                        try {
                            val file = verify(digest, buildNumber)
                            activity.runOnUiThread {
                                busy.set(false)
                                if (activity.isFinishing || activity.isDestroyed) {
                                    result.error("activity_closed", "Open the app again", null)
                                } else if (call.method == "verify") {
                                    result.success("verified")
                                } else {
                                    try {
                                        install(file, result)
                                    } catch (_: Exception) {
                                        result.error("install_failed", "Cannot open Android installer", null)
                                    }
                                }
                            }
                        } catch (_: Exception) {
                            activity.runOnUiThread {
                                busy.set(false)
                                result.error("verification_failed", "FMG update verification failed", null)
                            }
                        }
                    }.start()
                }
            }
        }
    }

    fun dispose() = channel.setMethodCallHandler(null)

    private fun verify(digest: String, expectedBuild: Long): File {
        val directory = File(activity.cacheDir, "fmg-updates").canonicalFile
        val file = File(directory, "$digest.apk").canonicalFile
        require(file.parentFile == directory && file.isFile && file.length() in 1024..104857600)
        val actual = file.inputStream().use { stream ->
            val hash = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(65536)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                hash.update(buffer, 0, count)
            }
            hash.digest().joinToString("") { "%02x".format(it) }
        }
        require(actual == digest)
        val flags = if (Build.VERSION.SDK_INT >= 28) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        @Suppress("DEPRECATION")
        val archive = activity.packageManager.getPackageArchiveInfo(file.path, flags)
            ?: throw IllegalArgumentException("Invalid APK")
        @Suppress("DEPRECATION")
        val current = activity.packageManager.getPackageInfo(APP_ID, flags)
        require(archive.packageName == APP_ID && version(archive) == expectedBuild &&
            expectedBuild > version(current))
        require(certificates(archive) == setOf(CERTIFICATE) &&
            certificates(current) == setOf(CERTIFICATE))
        // Android's package installer performs the final APK signature validation.
        return file
    }

    private fun certificates(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= 28) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        }
        return signatures.orEmpty().map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                .joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    private fun version(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) {
        info.longVersionCode
    } else {
        @Suppress("DEPRECATION")
        info.versionCode.toLong()
    }

    private fun install(file: File, result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:$APP_ID")))
            result.success("permission_required")
            return
        }
        val uri = FileProvider.getUriForFile(activity, "$APP_ID.fmgUpdates", file)
        activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        })
        result.success("installer_opened")
    }

    companion object {
        private const val APP_ID = "xyz.fmg.buzz.mobile"
        private const val CERTIFICATE =
            "b12c8b88ab806a09184d763424c49485164aff0e202626c643330f3f51182e93"
    }
}
