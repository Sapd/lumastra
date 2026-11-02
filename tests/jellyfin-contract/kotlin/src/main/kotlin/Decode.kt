import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer
import org.jellyfin.sdk.api.client.util.ApiSerializer
import java.io.File
import kotlin.system.exitProcess

// Decodes every contract-suite output with the SDK's own ApiSerializer.json, so
// coerceInputValues / isLenient behave exactly as in a real Jellyfin app.
fun main(args: Array<String>) {
    val outDir = File(args.getOrNull(0) ?: "../out")
    val manifest = Json.parseToJsonElement(File(outDir, "manifest.json").readText()).jsonArray
    var failures = 0
    for (entry in manifest) {
        val file = entry.jsonObject["file"]!!.jsonPrimitive.content
        val cls = entry.jsonObject["kotlinClass"]!!.jsonPrimitive.content
        val list = cls.startsWith("List<")
        val name = cls.removePrefix("List<").removeSuffix(">")
        val clazz = try {
            Class.forName("org.jellyfin.sdk.model.api.$name")
        } catch (e: ClassNotFoundException) {
            // Older SDKs predate some classes (e.g. SessionInfoDto in 1.6.3).
            println("skip $file -> $cls: class not in this SDK version")
            continue
        }
        @Suppress("UNCHECKED_CAST")
        val element = serializer(clazz) as KSerializer<Any>
        @Suppress("UNCHECKED_CAST")
        val ser: KSerializer<Any> = if (list) ListSerializer(element) as KSerializer<Any> else element
        val input = File(outDir, file)
        if (!input.isFile) {
            failures++
            println("FAIL $file -> $cls: output file missing")
            continue
        }
        try {
            ApiSerializer.json.decodeFromString(ser, input.readText())
            println("ok   $file -> $cls")
        } catch (e: Exception) {
            failures++
            println("FAIL $file -> $cls: ${e::class.simpleName}: ${e.message}")
        }
    }
    if (failures > 0) exitProcess(1)
}
