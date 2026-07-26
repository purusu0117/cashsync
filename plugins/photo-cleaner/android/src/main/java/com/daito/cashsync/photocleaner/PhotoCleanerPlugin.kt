package com.daito.cashsync.photocleaner

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * CashSync カスタムプラグイン：端末のスクリーンショット一覧取得と削除。
 * 削除は MediaStore.createDeleteRequest → OS標準の確認ダイアログが出る（API 30+）。
 */
@CapacitorPlugin(
    name = "PhotoCleaner",
    permissions = [
        Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES], alias = "photos"),
        Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "photosLegacy")
    ]
)
class PhotoCleanerPlugin : Plugin() {

    private var deleteLauncher: ActivityResultLauncher<IntentSenderRequest>? = null
    private var pendingDeleteCall: PluginCall? = null
    private var pendingDeleteCount = 0

    override fun load() {
        // MediaStore.createDeleteRequest の IntentSender を投げるランチャーを登録
        deleteLauncher = bridge.registerForActivityResult(
            ActivityResultContracts.StartIntentSenderForResult()
        ) { result ->
            val call = pendingDeleteCall
            pendingDeleteCall = null
            if (call != null) {
                val ret = JSObject()
                if (result.resultCode == Activity.RESULT_OK) {
                    ret.put("deleted", pendingDeleteCount)
                } else {
                    // ユーザーがOSダイアログでキャンセル
                    ret.put("deleted", 0)
                    ret.put("cancelled", true)
                }
                call.resolve(ret)
            }
        }
    }

    private fun readAlias(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "photos" else "photosLegacy"

    @PluginMethod
    fun listRecentScreenshots(call: PluginCall) {
        if (getPermissionState(readAlias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(readAlias(), call, "listPermissionCallback")
            return
        }
        doList(call)
    }

    @PermissionCallback
    private fun listPermissionCallback(call: PluginCall) {
        if (getPermissionState(readAlias()) == PermissionState.GRANTED) {
            doList(call)
        } else {
            call.reject("photo library permission denied")
        }
    }

    private fun doList(call: PluginCall) {
        val limit = call.getInt("limit") ?: 30
        val photos = JSArray()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.DATE_ADDED
        )
        // 「Screenshots」バケット（各メーカーのスクショ保存先の標準名）に絞る
        val selection = "${MediaStore.Images.Media.BUCKET_DISPLAY_NAME} = ?"
        val selectionArgs = arrayOf("Screenshots")
        val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} DESC"
        try {
            context.contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                selection,
                selectionArgs,
                sortOrder
            )?.use { cursor ->
                val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                val takenCol = cursor.getColumnIndex(MediaStore.Images.Media.DATE_TAKEN)
                val addedCol = cursor.getColumnIndex(MediaStore.Images.Media.DATE_ADDED)
                var n = 0
                while (cursor.moveToNext() && n < limit) {
                    val id = cursor.getLong(idCol)
                    val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                    val taken = if (takenCol >= 0) cursor.getLong(takenCol) else 0L
                    val added = if (addedCol >= 0) cursor.getLong(addedCol) * 1000 else 0L
                    val item = JSObject()
                    item.put("id", uri.toString())
                    item.put("takenAt", if (taken > 0) taken else added)
                    photos.put(item)
                    n++
                }
            }
        } catch (e: Exception) {
            call.reject("failed to query screenshots: ${e.message}")
            return
        }
        val ret = JSObject()
        ret.put("photos", photos)
        call.resolve(ret)
    }

    @PluginMethod
    fun deletePhotos(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("Android 11 以上が必要です")
            return
        }
        val idsArray = call.getArray("ids")
        if (idsArray == null || idsArray.length() == 0) {
            call.reject("ids required")
            return
        }
        val launcher = deleteLauncher
        if (launcher == null) {
            call.reject("plugin not initialized")
            return
        }
        val uris = mutableListOf<Uri>()
        try {
            for (i in 0 until idsArray.length()) {
                uris.add(Uri.parse(idsArray.getString(i)))
            }
        } catch (e: Exception) {
            call.reject("invalid ids: ${e.message}")
            return
        }
        try {
            val pendingIntent = MediaStore.createDeleteRequest(context.contentResolver, uris)
            call.setKeepAlive(true)
            pendingDeleteCall = call
            pendingDeleteCount = uris.size
            launcher.launch(IntentSenderRequest.Builder(pendingIntent.intentSender).build())
        } catch (e: Exception) {
            pendingDeleteCall = null
            call.reject("delete request failed: ${e.message}")
        }
    }
}
