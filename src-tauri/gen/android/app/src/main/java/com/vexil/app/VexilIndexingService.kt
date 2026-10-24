package com.vexil.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

@androidx.annotation.Keep
class VexilIndexingService : Service() {
  companion object {
    const val CHANNEL_ID = "vexil_indexing_channel"
    const val NOTIFICATION_ID = 1001

    fun start(context: Context) {
      val intent = Intent(context, VexilIndexingService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, VexilIndexingService::class.java)
      context.stopService(intent)
    }
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    val notification = buildNotification("Indexing files in background...")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Vexil Background Indexing",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Shows ongoing progress while Vexil indexes your files."
      }
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.createNotificationChannel(channel)
    }
  }

  private fun buildNotification(text: String): Notification {
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Vexil Search")
      .setContentText(text)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }
}
