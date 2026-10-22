/**
 * Stream one file from the phone to the console over HTTPS.
 *
 * This is the bulk-data path for pulls. `URLSession.uploadTask(withStreamedRequest:)`
 * reads the file through `InputStream`, so the daemon does not hold the whole
 * payload in memory and does not queue base64 WebSocket frames. The WebSocket
 * only sends the request and receives the final result.
 */

import CryptoKit
import Foundation
import Security

final class BridgeUploader: NSObject, URLSessionTaskDelegate {
	private let expectedPin: String?
	private let lock = NSLock()
	private var completion: ((Result<Int, Error>) -> Void)?
	private var session: URLSession?

	init(expectedPin: String?) {
		self.expectedPin = expectedPin?.lowercased().replacingOccurrences(of: ":", with: "")
		super.init()
	}

	func upload(filePath: String, url: URL, token: String, completion: @escaping (Result<Int, Error>) -> Void) {
		let attributes = try? FileManager.default.attributesOfItem(atPath: filePath)
		let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
		var request = URLRequest(url: url)
		request.httpMethod = "POST"
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
		request.setValue(String(size), forHTTPHeaderField: "Content-Length")
		request.timeoutInterval = 300
		request.httpBodyStream = InputStream(fileAtPath: filePath)

		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = 300
		let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
		self.session = session
		lock.lock()
		self.completion = completion
		lock.unlock()
		let task = session.uploadTask(withStreamedRequest: request)
		task.resume()
	}

	private func finish(_ result: Result<Int, Error>) {
		lock.lock()
		let callback = completion
		completion = nil
		lock.unlock()
		session?.finishTasksAndInvalidate()
		session = nil
		callback?(result)
	}

	func urlSession(
		_ session: URLSession,
		didReceive challenge: URLAuthenticationChallenge,
		completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
	) {
		guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
		      let trust = challenge.protectionSpace.serverTrust
		else {
			completionHandler(.performDefaultHandling, nil)
			return
		}
		guard let expectedPin, !expectedPin.isEmpty else {
			completionHandler(.performDefaultHandling, nil)
			return
		}
		let leaf: SecCertificate?
		if #available(iOS 15.0, macOS 12.0, *) {
			leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
		} else {
			leaf = SecTrustGetCertificateAtIndex(trust, 0)
		}
		guard let leaf else {
			completionHandler(.cancelAuthenticationChallenge, nil)
			return
		}
		let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
		if digest == expectedPin {
			completionHandler(.useCredential, URLCredential(trust: trust))
		} else {
			log("upload TLS pin mismatch: got \(digest)")
			completionHandler(.cancelAuthenticationChallenge, nil)
		}
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		if let error {
			finish(.failure(error))
			return
		}
		let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
		if status == 200 {
			finish(.success(Int(task.countOfBytesSent)))
		} else {
			finish(.failure(DeviceError.message("upload HTTP \(status)")))
		}
	}
}
