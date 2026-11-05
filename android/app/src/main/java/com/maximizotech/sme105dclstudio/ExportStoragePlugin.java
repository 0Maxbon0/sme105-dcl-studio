package com.maximizotech.sme105dclstudio;

import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.widget.Toast;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "ExportStorage")
public class ExportStoragePlugin extends Plugin {
    @PluginMethod
    public void save(PluginCall call) {
        Uri destination = null;
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                call.reject("Saving to Downloads requires Android 10 or later on this build.");
                return;
            }
            String sourceUri = call.getString("sourceUri", "");
            String name = call.getString("fileName", "");
            if (!name.matches("[A-Za-z0-9._-]+") || name.equals(".") || name.equals("..")) throw new Exception("Invalid export filename");
            File source = new File(Uri.parse(sourceUri).getPath()).getCanonicalFile();
            String cache = getContext().getCacheDir().getCanonicalPath() + File.separator;
            if (!source.getPath().startsWith(cache) || !source.isFile()) throw new Exception("Export source must be an app cache file");
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, name.endsWith(".zip") ? "application/zip" : name.endsWith(".csv") ? "text/csv" : "text/plain");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/SME105 DCL Studio");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            destination = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (destination == null) throw new Exception("Cannot create file in Downloads");
            try (FileInputStream input = new FileInputStream(source);
                 OutputStream output = getContext().getContentResolver().openOutputStream(destination)) {
                if (output == null) throw new Exception("Cannot open export destination");
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            ContentValues complete = new ContentValues();
            complete.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(destination, complete, null, null);
            JSObject result = new JSObject();
            result.put("uri", destination.toString());
            result.put("folder", "Internal storage/Download/SME105 DCL Studio");
            getActivity().runOnUiThread(() -> Toast.makeText(getContext(), "Saved in Downloads/SME105 DCL Studio", Toast.LENGTH_LONG).show());
            call.resolve(result);
        } catch (Exception error) {
            if (destination != null) getContext().getContentResolver().delete(destination, null, null);
            call.reject("Export was not saved: " + error.getMessage(), error);
        }
    }
}
